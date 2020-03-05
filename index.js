#!/usr/bin/env node

const fs = require("fs");
const sha512 = require("js-sha512");
const child_process = require("child_process");

let path = process.argv[2];

function readFilePromise(path) {
    return new Promise((resolve, reject) => {
        fs.readFile(path, (err, data) => {
            err ? reject(err) : resolve(data);
        });
    });
}

function writeFilePromise(path, data) {
    return new Promise((resolve, reject) => {
        fs.writeFile(path, data, (err) => {
            err ? reject(err) : resolve();
        });
    });
}

/** @return {Promise<fs.Stats>} */
function statFilePromise(path) {
    return new Promise((resolve, reject) => {
        fs.stat(path, (err, data) => {
            err ? reject(err) : resolve(data);
        });
    });
}

const ValueRangesSymbol = Symbol.for("ValueRangesSymbol");
const OriginalContentsSymbol = Symbol.for("OriginalContentsSymbol");

let prefix = "\n/** @autorun-";
let suffix = " */\n";
function getCommentValueLookup(contents) {
    let outputValues = Object.create(null);

    let ranges = [];

    outputValues[ValueRangesSymbol] = ranges;
    outputValues[OriginalContentsSymbol] = contents;

    let index = 0;
    while(true) {
        index = contents.indexOf(prefix, index);
        if(index < 0) break;
        let endIndex = contents.indexOf(suffix, index);
        if(endIndex < 0) break;

        let keyEnd = contents.indexOf(" ", index + prefix.length);
        let key = contents.slice(index + prefix.length, keyEnd);
        let value = contents.slice(keyEnd + 1, endIndex);

        outputValues[key] = value;
        ranges.push({ key, value, start: index, end: endIndex + suffix.length });

        index = endIndex + suffix.length;
    }

    return outputValues;
}

function getContentsFromLookup(valueLookup) {
    let ranges = valueLookup[ValueRangesSymbol];
    let contents = valueLookup[OriginalContentsSymbol];

    let foundKeys = Object.create(null);

    function formatValue(key, value) {
        return `${prefix}${key} ${value.replace(/\*\//g, "*\\/")}${suffix}`;
    }

    for(let i = ranges.length - 1; i >= 0; i--) {
        let { key, value, start, end } = ranges[i];
        if(key in valueLookup) {
            if(valueLookup[key] !== value) {
                contents = contents.slice(0, start) + formatValue(key, valueLookup[key]) + contents.slice(end);
            }
            foundKeys[key] = true;
        } else {
            contents = contents.slice(0, start) + contents.slice(end);
        }
    }

    for(let key in valueLookup) {
        if(key in foundKeys) continue;
        let value = valueLookup[key];
        // Put long values at the end of the file...
        if(String(value).length > 60 || key === "output") {
            contents = contents + formatValue(key, value);
        } else {
            contents = formatValue(key, value ) + contents;
        }
    }

    return contents;
}


let filesPending = Object.create(null);
let filesPendingTrigger = Object.create(null);

async function runOnFileName(fileName) {
    if(fileName in filesPending) {
        filesPendingTrigger[fileName] = true;
        return;
    }
    filesPending[fileName] = true;

    try {
        await runOnFileNameInner(fileName)
    } catch(err) {
        console.error(`Error running ${fileName}`, err);
    } finally {
        delete filesPending[fileName]
        if(filesPendingTrigger[fileName]) {
            delete filesPendingTrigger[fileName];
            runOnFileName(fileName);
        }
    }
}
async function runOnFileNameInner(fileName) {

    let filePath = path + "/" + fileName;
    /** @type {string} */
    let contents;
    /** @type {fs.Stats} */
    let stats;
    try {
        contents = (await readFilePromise(filePath)).toString("utf8");
        stats = await statFilePromise(filePath);
    } catch(e) { return; }

    function getHash(contents) {
        let values = getCommentValueLookup(contents);
        for(let key of Object.keys(values)) {
            delete values[key];
        }
        contents = getContentsFromLookup(values);
        
        //process.stdout.write("\n" + contents.replace(/\n|\r\n/g, "\\n") + "\n\n");
        return sha512.create().update(contents).hex();
    }

    let outputValues = getCommentValueLookup(contents);
    /*
    for(let key in outputValues) {
        console.log(JSON.stringify({key, value: String(outputValues[key]).slice(0, 100)}));
    }
    */

    let hash = getHash(contents);

    if(outputValues.lastRunHash === hash) {
        return;
    }

    console.log(`Rerunning ${fileName}`);

    let output = "\n";
    let proc = child_process.fork(filePath, [], { stdio: "pipe" });
    let done = false;

    async function writeContents() {
        if(done) return;

        let testCurOutputValues = Object.create(null);
        try {
            contents = (await readFilePromise(filePath)).toString("utf8");
            testCurOutputValues = getCommentValueLookup(contents);
        } catch(e) { }
        let shouldKill = "stop" in testCurOutputValues;
        if(shouldKill) {
            console.log(`Trying to stop previous run of file ${fileName}`);
            proc.kill("SIGKILL");
            outputValues = testCurOutputValues;
        } else {
            outputValues.output = output;
            outputValues.lastRunHash = hash;
        }
        delete outputValues.stop;

        contents = getContentsFromLookup(outputValues);
        if(!shouldKill) {
            let newHash = getHash(contents);
            if(hash !== newHash) {
                throw new Error(`Our file change will trigger a hash change, so our change is invalid.`);
            }
        }
        await writeFilePromise(filePath, contents);

        if(shouldKill) {
            done = true;
        }
    }

    let writeLoop = (async () => {
        while(!done) {
            await writeContents();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    })();

    await new Promise((resolve, reject) => {
        proc.on("error", err => {
            output += `\nEnding with error ${err}\n`;
            resolve();
        })
        proc.on("exit", code => {
            if(code !== 0) {
                output += `\nExit code non-0, was ${code}\n`;
            }
            resolve();
        });
        proc.stdout.on("data", (data) => {
            output += data.toString("utf8");
        });
        proc.stderr.on("err", (data) => {
            output += data.toString("utf8");
        });
    });

    if(!done) {
        done = true;
        console.log(`Finished ${fileName}`);
        await writeContents();
    }
}

fs.watch(path, async (change, fileName) => { runOnFileName(fileName); });

for(let startFileName of fs.readdirSync(path)) {
    runOnFileName(startFileName);
}