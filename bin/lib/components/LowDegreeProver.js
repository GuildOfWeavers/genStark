"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const merkle_1 = require("@guildofweavers/merkle");
const utils_1 = require("../utils");
const StarkError_1 = require("../StarkError");
// MODULE VARIABLES
// ================================================================================================
const MAX_REMAINDER_LENGTH = 256;
const REMAINDER_SLOTS = Math.log2(MAX_REMAINDER_LENGTH) / 2;
// CLASS DEFINITION
// ================================================================================================
class LowDegreeProver {
    // CONSTRUCTORS
    // --------------------------------------------------------------------------------------------
    constructor(idxGenerator, hash, context, logger) {
        this.field = context.field;
        this.polyRowSize = this.field.elementSize * 4;
        this.rootOfUnity = context.rootOfUnity;
        this.hash = hash;
        this.idxGenerator = idxGenerator;
        this.log = logger;
    }
    // PUBLIC METHODS
    // --------------------------------------------------------------------------------------------
    prove(cEvaluations, domain, maxDegreePlus1) {
        // transpose composition polynomial evaluations into a matrix with 4 columns
        const polyValues = this.field.transposeVector(cEvaluations, 4);
        // hash each row and put the result into a Merkle tree
        const polyHashes = this.hash.digestValues(polyValues.toBuffer(), this.polyRowSize);
        const pTree = merkle_1.MerkleTree.create(polyHashes, this.hash);
        this.log('Built liner combination merkle tree');
        // build Merkle proofs but swap out hashed values for the un-hashed ones
        const exeQueryPositions = this.idxGenerator.getExeIndexes(pTree.root, domain.length);
        const lcPositions = getAugmentedPositions(exeQueryPositions, cEvaluations.length);
        const lcProof = pTree.proveBatch(lcPositions);
        lcProof.values = polyValues.rowsToBuffers(lcPositions);
        this.log(`Computed ${lcPositions.length} linear combination spot checks`);
        // create a proof object to pass it to the fri() method
        const componentCount = getComponentCount(cEvaluations.length);
        const proof = {
            lcRoot: pTree.root,
            lcProof: lcProof,
            components: new Array(componentCount),
            remainder: []
        };
        // build and return FRI proof
        this.fri(pTree, polyValues, maxDegreePlus1, 0, domain, proof);
        return proof;
    }
    verify(proof, lcValues, exeQueryPositions, maxDegreePlus1) {
        let rootOfUnity = this.rootOfUnity;
        let columnLength = getRootOfUnityDegree(rootOfUnity, this.field);
        // powers of the given root of unity 1, p, p**2, p**3 such that p**4 = 1
        const quarticRootsOfUnity = [1n,
            this.field.exp(rootOfUnity, BigInt(columnLength) / 4n),
            this.field.exp(rootOfUnity, BigInt(columnLength) / 2n),
            this.field.exp(rootOfUnity, BigInt(columnLength) * 3n / 4n)];
        // 1 ----- check correctness of linear combination
        let lcProof = proof.lcProof;
        const lcPositions = getAugmentedPositions(exeQueryPositions, columnLength);
        const lcChecks = this.parseColumnValues(lcProof.values, exeQueryPositions, lcPositions, columnLength);
        lcProof = utils_1.rehashMerkleProofValues(lcProof, this.hash);
        if (!merkle_1.MerkleTree.verifyBatch(proof.lcRoot, lcPositions, lcProof, this.hash)) {
            throw new StarkError_1.StarkError(`Verification of linear combination Merkle proof failed`);
        }
        for (let i = 0; i < lcValues.length; i++) {
            if (lcValues[i] !== lcChecks[i]) {
                throw new StarkError_1.StarkError(`Verification of linear combination correctness failed`);
            }
        }
        // 2 ----- verify the recursive components of the FRI proof
        let pRoot = proof.lcRoot;
        columnLength = Math.floor(columnLength / 4);
        for (let depth = 0; depth < proof.components.length; depth++) {
            let { columnRoot, columnProof, polyProof } = proof.components[depth];
            // calculate pseudo-random indexes for column and poly values
            let positions = this.idxGenerator.getFriIndexes(columnRoot, columnLength);
            let augmentedPositions = getAugmentedPositions(positions, columnLength);
            // verify Merkle proof for the column
            let columnValues = this.parseColumnValues(columnProof.values, positions, augmentedPositions, columnLength);
            columnProof = utils_1.rehashMerkleProofValues(columnProof, this.hash);
            if (!merkle_1.MerkleTree.verifyBatch(columnRoot, augmentedPositions, columnProof, this.hash)) {
                throw new StarkError_1.StarkError(`Verification of column Merkle proof failed at depth ${depth}`);
            }
            // verify Merkle proof for polynomials
            let polyValues = this.parsePolyValues(polyProof.values);
            polyProof = utils_1.rehashMerkleProofValues(polyProof, this.hash);
            if (!merkle_1.MerkleTree.verifyBatch(pRoot, positions, polyProof, this.hash)) {
                throw new StarkError_1.StarkError(`Verification of polynomial Merkle proof failed at depth ${depth}`);
            }
            // build a set of x coordinates for each row polynomial
            let xs = new Array(positions.length);
            for (let i = 0; i < positions.length; i++) {
                let xe = this.field.exp(rootOfUnity, BigInt(positions[i]));
                xs[i] = new Array(4);
                xs[i][0] = this.field.mul(quarticRootsOfUnity[0], xe);
                xs[i][1] = this.field.mul(quarticRootsOfUnity[1], xe);
                xs[i][2] = this.field.mul(quarticRootsOfUnity[2], xe);
                xs[i][3] = this.field.mul(quarticRootsOfUnity[3], xe);
            }
            // calculate the pseudo-random x coordinate
            let specialX = this.field.prng(pRoot);
            // interpolate x and y values into row polynomials
            let xValues = this.field.newMatrixFrom(xs);
            let yValues = this.field.newMatrixFrom(polyValues);
            let polys = this.field.interpolateQuarticBatch(xValues, yValues);
            // check that when the polynomials are evaluated at x, the result is equal to the corresponding column value
            let pEvaluations = this.field.evalQuarticBatch(polys, specialX);
            for (let i = 0; i < polys.rowCount; i++) {
                if (pEvaluations.getValue(i) !== columnValues[i]) {
                    throw new StarkError_1.StarkError(`Degree 4 polynomial didn't evaluate to column value at depth ${depth}`);
                }
            }
            // update constants to check the next component
            pRoot = columnRoot;
            rootOfUnity = this.field.exp(rootOfUnity, 4n);
            maxDegreePlus1 = Math.floor(maxDegreePlus1 / 4);
            columnLength = Math.floor(columnLength / 4);
        }
        // 3 ----- verify the remainder of the FRI proof
        if (maxDegreePlus1 > proof.remainder.length) {
            throw new StarkError_1.StarkError(`Remainder degree is greater than number of remainder values`);
        }
        const remainder = this.field.newVectorFrom(proof.remainder);
        // check that Merkle root matches up
        const polyValues = this.field.transposeVector(remainder, 4);
        const polyHashes = this.hash.digestValues(polyValues.toBuffer(), this.polyRowSize);
        const cTree = merkle_1.MerkleTree.create(polyHashes, this.hash);
        if (!cTree.root.equals(pRoot)) {
            throw new StarkError_1.StarkError(`Remainder values do not match Merkle root of the last column`);
        }
        this.verifyRemainder(remainder, maxDegreePlus1, rootOfUnity);
        return true;
    }
    // HELPER METHODS
    // --------------------------------------------------------------------------------------------
    fri(pTree, polyValues, maxDegreePlus1, depth, domain, result) {
        // if there are not too many values left, use the polynomial values directly as proof
        if (polyValues.rowCount * polyValues.colCount <= MAX_REMAINDER_LENGTH) {
            const rootOfUnity = this.field.exp(domain.getValue(1), BigInt(4 ** depth));
            const tValues = this.field.transposeMatrix(polyValues);
            const remainder = this.field.joinMatrixRows(tValues);
            this.verifyRemainder(remainder, maxDegreePlus1, rootOfUnity);
            result.remainder = remainder.toValues();
            this.log(`Computed FRI remainder of ${remainder.length} values`);
            return;
        }
        // build polynomials from each row of the polynomial value matrix
        const xs = this.field.transposeVector(domain, 4, (4 ** depth));
        const polys = this.field.interpolateQuarticBatch(xs, polyValues);
        // select a pseudo-random x coordinate and evaluate each row polynomial at that coordinate
        const specialX = this.field.prng(pTree.root);
        const column = this.field.evalQuarticBatch(polys, specialX);
        // break the column in a polynomial value matrix for the next layer of recursion
        const newPolyValues = this.field.transposeVector(column, 4);
        // put the resulting matrix into a Merkle tree
        const rowHashes = this.hash.digestValues(newPolyValues.toBuffer(), this.polyRowSize);
        const cTree = merkle_1.MerkleTree.create(rowHashes, this.hash);
        // recursively build all other components
        this.log(`Computed FRI layer at depth ${depth}`);
        this.fri(cTree, newPolyValues, Math.floor(maxDegreePlus1 / 4), depth + 1, domain, result);
        // compute spot check positions in the column and corresponding positions in the original values
        const positions = this.idxGenerator.getFriIndexes(cTree.root, column.length);
        const augmentedPositions = getAugmentedPositions(positions, column.length);
        // build Merkle proofs but swap out hashed values for the un-hashed ones
        const columnProof = cTree.proveBatch(augmentedPositions);
        columnProof.values = newPolyValues.rowsToBuffers(augmentedPositions);
        const polyProof = pTree.proveBatch(positions);
        polyProof.values = polyValues.rowsToBuffers(positions);
        // build and add proof component to the result
        result.components[depth] = { columnRoot: cTree.root, columnProof, polyProof };
    }
    verifyRemainder(remainder, maxDegreePlus1, rootOfUnity) {
        // exclude points which should be skipped during evaluation
        const positions = [];
        for (let i = 0; i < remainder.length; i++) {
            if (!this.idxGenerator.extensionFactor || i % this.idxGenerator.extensionFactor) {
                positions.push(i);
            }
        }
        // pick a subset of points from the remainder and interpolate them into a polynomial
        const domain = this.field.getPowerSeries(rootOfUnity, remainder.length);
        const xs = new Array(maxDegreePlus1);
        const ys = new Array(maxDegreePlus1);
        for (let i = 0; i < maxDegreePlus1; i++) {
            let p = positions[i];
            xs[i] = domain.getValue(p);
            ys[i] = remainder.getValue(p);
        }
        const xVector = this.field.newVectorFrom(xs);
        const yVector = this.field.newVectorFrom(ys);
        const poly = this.field.interpolate(xVector, yVector);
        // check that polynomial evaluates correctly for all other points in the remainder
        for (let i = maxDegreePlus1; i < positions.length; i++) {
            let p = positions[i];
            if (this.field.evalPolyAt(poly, domain.getValue(p)) !== remainder.getValue(p)) {
                throw new StarkError_1.StarkError(`Remainder is not a valid degree ${maxDegreePlus1 - 1} polynomial`);
            }
        }
    }
    // PARSERS
    // --------------------------------------------------------------------------------------------
    parsePolyValues(buffers) {
        const elementSize = this.field.elementSize;
        const result = [];
        for (let buffer of buffers) {
            let values = new Array(4), offset = 0;
            ;
            for (let i = 0; i < 4; i++, offset += elementSize) {
                values[i] = utils_1.readBigInt(buffer, offset, elementSize);
            }
            result.push(values);
        }
        return result;
    }
    parseColumnValues(buffers, positions, augmentedPositions, columnLength) {
        const rowLength = columnLength / 4;
        const elementSize = this.field.elementSize;
        const result = [];
        for (let position of positions) {
            let idx = augmentedPositions.indexOf(position % rowLength);
            let buffer = buffers[idx];
            let offset = Math.floor(position / rowLength) * elementSize;
            result.push(utils_1.readBigInt(buffer, offset, elementSize));
        }
        return result;
    }
}
exports.LowDegreeProver = LowDegreeProver;
// HELPER FUNCTIONS
// ================================================================================================
function getComponentCount(valueCount) {
    let result = Math.ceil(Math.log2(valueCount) / 2); // round up log(valueCount, 4);
    result -= REMAINDER_SLOTS;
    return Math.min(result, 0);
}
function getRootOfUnityDegree(rootOfUnity, field) {
    let result = 1;
    while (rootOfUnity !== 1n) {
        result = result * 2;
        rootOfUnity = field.mul(rootOfUnity, rootOfUnity);
    }
    return result;
}
function getAugmentedPositions(positions, columnLength) {
    const rowLength = columnLength / 4;
    const result = new Set();
    for (let position of positions) {
        result.add(Math.floor(position % rowLength));
    }
    return Array.from(result);
}
//# sourceMappingURL=LowDegreeProver.js.map