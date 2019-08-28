// IMPORTS
// ================================================================================================
import { LowDegreeProof, FriComponent, LogFunction } from "@guildofweavers/genstark";
import { FiniteField, Vector, Matrix } from '@guildofweavers/air-script';
import { MerkleTree, Hash } from '@guildofweavers/merkle';
import { QueryIndexGenerator } from "./QueryIndexGenerator";
import { buffersToBigInts, readBigInt } from "../utils";
import { StarkError } from '../StarkError';

// CLASS DEFINITION
// ================================================================================================
export class LowDegreeProver {

    private readonly field          : FiniteField;
    private readonly idxGenerator   : QueryIndexGenerator;
    private readonly hash           : Hash;
    private readonly log            : LogFunction

    // CONSTRUCTORS
    // --------------------------------------------------------------------------------------------
    constructor(field: FiniteField, idxGenerator: QueryIndexGenerator, hash: Hash, logger: LogFunction) {
        this.field = field;
        this.hash = hash;
        this.idxGenerator = idxGenerator;
        this.log = logger;
    }

    // PUBLIC METHODS
    // --------------------------------------------------------------------------------------------
    prove(lTree: MerkleTree, values: Matrix, domain: Vector, maxDegreePlus1: number) {

        const valueCount = values.colCount * values.rowCount; // TODO: improve
        const componentCount = Math.min(Math.ceil(Math.log2(valueCount) / 2) - 4, 0);

        const result: LowDegreeProof = {
            components  : new Array<FriComponent>(componentCount),
            remainder   : []
        };

        this.fri(lTree, values, maxDegreePlus1, 0, domain, result);
        return result;
    }

    verify(lRoot: Buffer, maxDegreePlus1: number, rootOfUnity: bigint, proof: LowDegreeProof) {

        let rouDegree = computeRootOfUnityDegree(rootOfUnity, this.field);

        // powers of the given root of unity 1, p, p**2, p**3 such that p**4 = 1
        const quarticRootsOfUnity = [1n,
            this.field.exp(rootOfUnity, BigInt(rouDegree) / 4n),
            this.field.exp(rootOfUnity, BigInt(rouDegree) / 2n),
            this.field.exp(rootOfUnity, BigInt(rouDegree) * 3n / 4n)];

        // 1 ----- verify the recursive components of the proof
        for (let depth = 0; depth < proof.components.length; depth++) {
            let { columnRoot, columnProof, polyProof } = proof.components[depth];

            // calculate the pseudo-randomly sampled y indices
            let columnLength = Math.floor(rouDegree / 4);
            let positions = this.idxGenerator.getFriIndexes(columnRoot, columnLength);
            let augmentedPositions = getAugmentedPositions(positions, columnLength / 4);

            // verify Merkle proof for the column
            let columnValues = parseColumnValues(columnProof.values, positions, augmentedPositions, columnLength / 4, this.field.elementSize);
            columnProof.values = hashBuffers(columnProof.values, this.hash);    // TODO: don't mutate the proof
            if (!MerkleTree.verifyBatch(columnRoot, augmentedPositions, columnProof, this.hash)) {
                throw new StarkError(`Verification of column Merkle proof failed at depth ${depth}`);
            }

            // verify Merkle proof for polynomials
            let ys = parsePolyValues(polyProof.values, this.field.elementSize);
            polyProof.values = hashBuffers(polyProof.values, this.hash);
            if (!MerkleTree.verifyBatch(lRoot, positions, polyProof, this.hash)) {
                throw new StarkError(`Verification of polynomial Merkle proof failed at depth ${depth}`);
            }

            // For each y coordinate, get the x coordinates on the row, the values on
            // the row, and the value at that y from the column
            let xs = new Array<bigint[]>(positions.length);
            for (let i = 0; i < positions.length; i++) {
                let xe = this.field.exp(rootOfUnity, BigInt(positions[i]));
                xs[i] = new Array(4);
                xs[i][0] = this.field.mul(quarticRootsOfUnity[0], xe);
                xs[i][1] = this.field.mul(quarticRootsOfUnity[1], xe);
                xs[i][2] = this.field.mul(quarticRootsOfUnity[2], xe);
                xs[i][3] = this.field.mul(quarticRootsOfUnity[3], xe);
            }
            
            // calculate the pseudo-random x coordinate
            const specialX = this.field.prng(lRoot);

            // verify for each selected y coordinate that the four points from the polynomial and the 
            // one point from the column that are on that y coordinate are on the same deg < 4 polynomial
            const polys = this.field.interpolateQuarticBatch(this.field.newMatrixFrom(xs), this.field.newMatrixFrom(ys));
            
            const polyVectors = this.field.matrixRowsToVectors(polys);
            for (let i = 0; i < polys.rowCount; i++) {
                if (this.field.evalPolyAt(polyVectors[i], specialX) !== columnValues[i]) {
                    throw new StarkError(`Degree 4 polynomial didn't evaluate to column value at depth ${depth}`);
                }
            }

            // update constants to check the next component
            lRoot = columnRoot;
            rootOfUnity = this.field.exp(rootOfUnity, 4n);
            maxDegreePlus1 = Math.floor(maxDegreePlus1 / 4);
            rouDegree = Math.floor(rouDegree / 4);
        }

        // 2 ----- verify the remainder of the proof
        if (maxDegreePlus1 > proof.remainder.length) {
            throw new StarkError(`Remainder degree is greater than number of remainder values`);
        }

        const remainder = this.field.newVectorFrom(buffersToBigInts(proof.remainder));

        // check that Merkle root matches up
        const rMatrix = this.field.transposeVector(remainder, 4);
        const rHashes = this.hash.digestValues(rMatrix.toBuffer(), 4 * this.field.elementSize);
        const cTree = MerkleTree.create(rHashes, this.hash);
        if (!cTree.root.equals(lRoot)) {
            throw new StarkError(`Remainder values do not match Merkle root of the last column`);
        }
        
        this.verifyRemainder(remainder, maxDegreePlus1, rootOfUnity);

        return true;
    }

    // HELPER METHODS
    // --------------------------------------------------------------------------------------------
    private fri(lTree: MerkleTree, values: Matrix, maxDegreePlus1: number, depth: number, domain: Vector, result: LowDegreeProof) {

        // if there are not too many values left, use the polynomial directly as proof
        if (values.rowCount <= 64) {
            const rootOfUnity = this.field.exp(domain.getValue(1), BigInt(4**depth));
            const tValues = this.field.transposeMatrix(values);
            const remainder = this.field.joinMatrixRows(tValues);
            this.verifyRemainder(remainder, maxDegreePlus1, rootOfUnity);
            result.remainder = splitBuffer(remainder.toBuffer(), this.field.elementSize);
            this.log(`Computed FRI remainder of ${remainder.length} values`);
            return;
        }

        // build polynomials from each row of the values matrix
        const xs = this.field.transposeVector(domain, 4, (4**depth));
        const polys = this.field.interpolateQuarticBatch(xs, values);

        // select a pseudo-random x coordinate and evaluate each row polynomial at that coordinate
        const specialX = this.field.prng(lTree.root);
        const column = this.field.evalQuarticBatch(polys, specialX);

        // break the column in 4 sets of values for the next level
        const newValues = this.field.transposeVector(column, 4);

        // put the resulting column into a merkle tree
        const rowHashes = this.hash.digestValues(newValues.toBuffer(), 4 * this.field.elementSize);
        const cTree = MerkleTree.create(rowHashes, this.hash);

        // recursively build all other components
        this.log(`Computed FRI layer at depth ${depth}`);
        this.fri(cTree, newValues, Math.floor(maxDegreePlus1 / 4), depth + 1, domain, result);

        // compute spot check positions in the column and corresponding positions in the original values
        const positions = this.idxGenerator.getFriIndexes(cTree.root, column.length);
        const augmentedPositions = getAugmentedPositions(positions, column.length / 4);

        // build merkle proofs and but swap out hashed values for the un-hashed ones
        const columnProof = cTree.proveBatch(augmentedPositions);
        columnProof.values = rowsToBuffers(newValues, augmentedPositions, this.field);

        const polyProof = lTree.proveBatch(positions);
        polyProof.values = rowsToBuffers(values, positions, this.field);

        // build and add proof component to the result
        result.components[depth] = { columnRoot: cTree.root, columnProof, polyProof };
    }

    private verifyRemainder(remainder: Vector, maxDegreePlus1: number, rootOfUnity: bigint) {
        // exclude points which should be skipped during evaluation
        const positions: number[] = [];
        for (let i = 0; i < remainder.length; i++) {
            if (!this.idxGenerator.extensionFactor || i % this.idxGenerator.extensionFactor) {
                positions.push(i);
            }
        }

        // pick a subset of points from the remainder and interpolate them into a polynomial
        const domain = this.field.getPowerSeries(rootOfUnity, remainder.length);
        const xs = new Array<bigint>(maxDegreePlus1);
        const ys = new Array<bigint>(maxDegreePlus1);
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
                throw new StarkError(`Remainder is not a valid degree ${maxDegreePlus1 - 1} polynomial`);
            }
        }
    }
}

// HELPER FUNCTIONS
// ================================================================================================
function computeRootOfUnityDegree(rootOfUnity: bigint, field: FiniteField): number {
    let result = 1;
    while (rootOfUnity !== 1n) {
        result = result * 2;
        rootOfUnity = field.mul(rootOfUnity, rootOfUnity);
    }
    return result;
}

function splitBuffer(buffer: Buffer, elementSize: number): Buffer[] {
    const elementCount = buffer.byteLength / elementSize;
    const result = new Array<Buffer>(elementCount);
    for (let i = 0, offset = 0; i < elementCount; i++, offset += elementSize) {
        result[i] = buffer.slice(offset, offset + elementSize)
    }
    return result;
}

function getAugmentedPositions(positions: number[], rowLength: number) {
    const result = new Set<number>();
    for (let position of positions) {
        result.add(Math.floor(position % rowLength));
    }
    return Array.from(result);
}

function parsePolyValues(buffers: Buffer[], elementSize: number) {
    const result: bigint[][] = [];
    for (let buffer of buffers) {
        let values = new Array<bigint>(4), offset = 0;;
        for (let i = 0; i < 4; i++, offset += elementSize) {
            values[i] = readBigInt(buffer, offset, elementSize);
        }
        result.push(values);
    }
    return result;
}

function parseColumnValues(buffers: Buffer[], positions: number[], augmentedPositions: number[], rowLength: number, elementSize: number) {
    const result: bigint[] = [];
    for (let position of positions) {
        let idx = augmentedPositions.indexOf(position % rowLength);
        let buffer = buffers[idx];
        let offset = Math.floor(position / rowLength) * elementSize;
        result.push(readBigInt(buffer, offset, elementSize));
    }
    return result;
}

function rowsToBuffers(matrix: Matrix, positions: number[], field: FiniteField): Buffer[] {
    const vectors = field.matrixRowsToVectors(matrix);
    const result = new Array<Buffer>();
    for (let position of positions) {
        result.push(vectors[position].toBuffer());
    }
    return result;
}

function hashBuffers(values: Buffer[], hash: Hash): Buffer[] {
    const result = new Array<Buffer>(values.length);
    for (let i = 0; i < values.length; i++) {
        result[i] = hash.digest(values[i]);
    }
    return result;
}