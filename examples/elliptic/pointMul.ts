// IMPORTS
// ================================================================================================
import * as assert from 'assert';
import { StarkOptions } from '@guildofweavers/genstark';
import { instantiate } from '../../index';
import { Logger } from '../../lib/utils';

// STARK DEFINITION
// ================================================================================================
// define security options for the STARK
const options: StarkOptions = {
    hashAlgorithm   : 'blake2s256',
    extensionFactor : 16,
    exeQueryCount   : 48,
    friQueryCount   : 24,
    wasm            : false
};

// create the STARK for elliptic curve point multiplication computation
const ecStark = instantiate('./examples/elliptic/pointmul.aa', 'default', options, new Logger(false));

// TESTING
// ================================================================================================
const inputs = [
    [19277929113566293071110308034699488026831934219452440156649784352033n],        // x coordinate
    [19926808758034470970197974370888749184205991990603949537637343198772n],        // y coordinate
    [toBits(21628546220445634706341881427918508772248629391536891476641575405363n)] // value to multiply by
];

const controls = [
    5326626235735428056996404471396244610891648579045949976641038973984n,   // expected x coordinate
    6753729428472267765045584530315486521937702623726344079323769311058n    // expected y coordinate
];

// set up inputs and assertions
const assertions = [
    { step: 255, register: 2, value: controls[0] },
    { step: 255, register: 3, value: controls[1] }
];

// prove that the assertions hold if we execute multiplication with given inputs
let proof = ecStark.prove(assertions, inputs);
console.log('-'.repeat(20));

// serialize the proof
let start = Date.now();
const buf = ecStark.serialize(proof);
console.log(`Proof serialized in ${Date.now() - start} ms; size: ${Math.round(buf.byteLength / 1024 * 100) / 100} KB`);
assert(buf.byteLength === ecStark.sizeOf(proof));
console.log('-'.repeat(20));

// deserialize the proof to make sure everything serialized correctly
start = Date.now();
proof = ecStark.parse(buf);
console.log(`Proof parsed in ${Date.now() - start} ms`);
console.log('-'.repeat(20));

// verify the proof
ecStark.verify(assertions, proof);
console.log('-'.repeat(20));
console.log(`STARK security level: ${ecStark.securityLevel}`);

// HELPER FUNCTIONS
// ================================================================================================
function toBits(value: bigint) {
    const bits = value.toString(2).padStart(256, '0').split('');
    return bits.reverse().map(b => BigInt(b));
}