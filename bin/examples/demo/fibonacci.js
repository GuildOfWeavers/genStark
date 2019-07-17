"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// IMPORTS
// ================================================================================================
const assert = require("assert");
const index_1 = require("../../index");
// STARK DEFINITION
// ================================================================================================
//const steps = 2**6, result = 1783540607n;         // ~50 ms to prove, ~9 KB proof size
const steps = 2 ** 13, result = 203257732n; // ~1 second to prove, ~140 KB proof size
//const steps = 2**17, result = 2391373091n;        // ~13 seconds to prove, ~280 KB proof size
const fibStark = new index_1.Stark(`
define Fibonacci over prime field (2^32 - 3 * 2^25 + 1) {

    transition 2 registers in ${steps} steps {
        a0: $r0 + $r1;
        out: [a0, a0 + $r1];
    }

    enforce 2 constraints {
        a0: $r0 + $r1;
        out: [$n0 - a0, $n1 - (a0 + $r1)];
    }

}`);
// TESTING
// ================================================================================================
// set up inputs and assertions
const initValues = [1n, 1n]; // step 0 and 1 in Fibonacci sequence are 1
const assertions = [
    { step: 0, register: 0, value: 1n },
    { step: 0, register: 1, value: 1n },
    { step: steps - 1, register: 1, value: result } // value at the last step is equal to result
];
// prove that the assertions hold if we execute Fibonacci computation
let proof = fibStark.prove(assertions, initValues);
console.log('-'.repeat(20));
// serialize the proof
let start = Date.now();
const buf = fibStark.serialize(proof);
console.log(`Proof serialized in ${Date.now() - start} ms; size: ${Math.round(buf.byteLength / 1024 * 100) / 100} KB`);
assert(buf.byteLength === fibStark.sizeOf(proof));
console.log('-'.repeat(20));
// deserialize the proof to make sure everything serialized correctly
start = Date.now();
proof = fibStark.parse(buf);
console.log(`Proof parsed in ${Date.now() - start} ms`);
console.log('-'.repeat(20));
// verify the proof
fibStark.verify(assertions, proof);
console.log('-'.repeat(20));
//# sourceMappingURL=fibonacci.js.map