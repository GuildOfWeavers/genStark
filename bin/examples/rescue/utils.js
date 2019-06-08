"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// IMPORTS
// ================================================================================================
const index_1 = require("../../index");
// STARK DEFINITION
// ================================================================================================
const field = new index_1.PrimeField(2n ** 64n - 21n * 2n ** 30n + 1n);
const alpha = 3n;
const invAlpha = -6148914683720324437n;
const registers = 2;
const rounds = 32;
// MDS matrix
const mds = [
    [18446744051160973310n, 18446744051160973301n],
    [4n, 13n]
];
const initialConstants = [1908230773479027697n, 11775995824954138427n];
const constantsConstant = [17002767073604012844n, 4907993559994152336n];
const constantsMatrix = [
    [18345613653544031596n, 8765075832563166921n],
    [10398013025088720944n, 5494050611496560306n]
];
const keyConstants = unrollConstants();
//printConstants(keyConstants);
const result = sponge([42n], keyConstants);
console.log(result.hash);
// CONSTANT PROCESSORS
// ================================================================================================
function unrollConstants() {
    const result = new Array();
    // initial state
    let keyState = new Array(registers).fill(0n);
    let keyInjection = initialConstants;
    keyState = vadd(keyState, keyInjection);
    result.push([...keyState]);
    // record key state for each round
    for (let r = 0; r <= rounds; r++) {
        // round r, step 1
        for (let i = 0; i < registers; i++) {
            keyState[i] = field.exp(keyState[i], invAlpha);
        }
        keyInjection = vadd(mmul(constantsMatrix, keyInjection), constantsConstant);
        keyState = vadd(mmul(mds, keyState), keyInjection);
        result.push([...keyState]);
        // round r, step 2
        for (let i = 0; i < registers; i++) {
            keyState[i] = field.exp(keyState[i], alpha);
        }
        keyInjection = vadd(mmul(constantsMatrix, keyInjection), constantsConstant);
        keyState = vadd(mmul(mds, keyState), keyInjection);
        result.push([...keyState]);
    }
    return result;
}
function printConstants(constants) {
    // first 2 elements from constant trace go into initial constants
    const initialConstants = [...constants[0], ...constants[1]];
    // all other elements go into round constants
    const roundConstants = new Array(registers * 2);
    for (let i = 0; i < roundConstants.length; i++) {
        roundConstants[i] = new Array(rounds);
    }
    for (let i = 0, k = 2; i < rounds; i++, k += 2) {
        for (let j = 0; j < registers; j++) {
            roundConstants[j][i] = constants[k][j];
            roundConstants[registers + j][i] = constants[k + 1][j];
        }
    }
    // print the constants in pretty form
    let output = `const initialConstants = [\n\t\t${initialConstants.join('n,\t')}\n];\n\n`;
    output += 'const roundConstants = [\n';
    for (let i = 0; i < registers * 2; i++) {
        output += '\t[\n\t';
        for (let j = 0; j < rounds; j++) {
            if (j !== 0 && j % 4 === 0) {
                output += '\n\t';
            }
            output += `\t${roundConstants[i][j]}n,`;
        }
        output += '\n\t],\n';
    }
    console.log(`${output}];`);
}
// SPONGE FUNCTION
// ================================================================================================
function sponge(inputs, unrolledKeys) {
    const trace = new Array();
    // copy inputs to state
    let state = new Array(registers).fill(0n);
    for (let i = 0; i < inputs.length; i++) {
        state[i] = inputs[i];
    }
    trace.push([...state]);
    // run through block cipher rounds
    state = vadd(state, unrolledKeys[0]);
    trace.push([...state]);
    for (let r = 0, k = 1; r < rounds; r++, k += 2) {
        // round r, step 1
        for (let i = 0; i < registers; i++) {
            state[i] = field.exp(state[i], invAlpha);
        }
        state = vadd(mmul(mds, state), unrolledKeys[k]);
        trace.push([...state]);
        // round r, step 2
        for (let i = 0; i < registers; i++) {
            state[i] = field.exp(state[i], alpha);
        }
        state = vadd(mmul(mds, state), unrolledKeys[k + 1]);
        trace.push([...state]);
    }
    // build and return output
    const output = new Array(inputs.length);
    for (let i = 0; i < output.length; i++) {
        output[i] = state[i];
    }
    return { hash: output, trace };
}
// HELPER FUNCTIONS
// ================================================================================================
function vadd(a, b) {
    const result = [];
    for (let i = 0; i < a.length; i++) {
        result.push(field.add(a[i], b[i]));
    }
    return result;
}
function mmul(a, b) {
    const result = [];
    for (let i = 0; i < a.length; i++) {
        let s = 0n;
        for (let j = 0; j < a[i].length; j++) {
            s = field.add(s, field.mul(a[i][j], b[j]));
        }
        result.push(s);
    }
    return result;
}
//# sourceMappingURL=utils.js.map