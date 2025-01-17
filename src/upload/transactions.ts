import {
    Blockhash,
    Commitment,
    Connection,
    RpcResponseAndContext,
    SignatureStatus,
    SimulatedTransactionResponse,
    Transaction,
    TransactionInstruction,
    TransactionSignature,
    Keypair,
} from '@safecoin/web3.js'
import { DEFAULT_TIMEOUT } from '../constants'
import { getUnixTs, sleep } from './helpers'

interface IBlockhashAndFeeCalculator {
    blockhash: Blockhash
    lastValidBlockHeight: number
}
/**
 * Attempt to send a transaction to the network.
 * @param connection  The connection to the cluster.
 * @param wallet  The wallet to use for signing.
 * @param instructions  The instructions to sign.
 * @param commitment  The commitment to use for the transaction.
 * @param block  The blockhash to use for the transaction.
 * @param beforeSend  The function to call before sending the transaction.
 * @returns  The transaction signature.
 */
export const sendTransactionWithRetryWithKeypair = async (
    connection: Connection,
    wallet: any,
    instructions: TransactionInstruction[],
    commitment: Commitment = 'singleGossip',
    block?: IBlockhashAndFeeCalculator,
    beforeSend?: () => void
) => {
    const transaction = new Transaction()
    instructions.forEach((instruction) => transaction.add(instruction))
    transaction.recentBlockhash = (block || (await connection.getLatestBlockhash(commitment))).blockhash
    transaction.feePayer = wallet.publicKey
    await wallet.signTransaction(transaction)

    if (beforeSend) {
        beforeSend()
    }

    const { txid, slot } = await sendSignedTransaction({
        connection,
        signedTransaction: transaction,
    })

    return { txid, slot }
}
/**
 * Attempt to send a signed transaction to the network.
 * @param signedTransaction The signed transaction to send. 
 * @param connection The connection to the cluster.
 * @returns  The transaction id and slot.
 */
export async function sendSignedTransaction({
    signedTransaction,
    connection,
    timeout = DEFAULT_TIMEOUT,
}: {
    signedTransaction: Transaction
    connection: Connection
    sendingMessage?: string
    sentMessage?: string
    successMessage?: string
    timeout?: number
}): Promise<{ txid: string; slot: number }> {
    const rawTransaction = signedTransaction.serialize()
    const startTime = getUnixTs()
    let slot = 0

    let txid: TransactionSignature = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
    })

    console.log('Started awaiting confirmation for', txid)

    let done = false
    ;(async () => {
        while (!done && getUnixTs() - startTime < timeout) {
            connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
            })
            await sleep(500)
        }
    })()

    try {
        const confirmation = await awaitTransactionSignatureConfirmation(txid, timeout, connection, 'confirmed', true)
        if (!confirmation) throw new Error('Timed out awaiting confirmation on transaction')

        if (confirmation.err) {
            console.error(confirmation.err)
            throw new Error('Transaction failed: Custom instruction error')
        }
        slot = confirmation?.slot || 0
    } catch (err) {
        console.error('Timeout Error caught', err)
        // @ts-ignore
        if (err.timeout) {
            throw new Error('Timed out awaiting confirmation on transaction')
        }
        let simulateResult: SimulatedTransactionResponse | null = null
        try {
            simulateResult = (await simulateTransaction(connection, signedTransaction, 'single')).value
        } catch (e) {
            console.error('Simulate Transaction error', e)
        }
        if (simulateResult && simulateResult.err) {
            if (simulateResult.logs) {
                for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
                    const line = simulateResult.logs[i]
                    if (line.startsWith('Program log: ')) {
                        throw new Error('Transaction failed: ' + line.slice('Program log: '.length))
                    }
                }
            }
            throw new Error(JSON.stringify(simulateResult.err))
        }
        console.error('Got this far.')
        txid = simulateResult?.err as string
        // throw new Error('Transaction failed');
    } finally {
        done = true
    }

    console.log('Latency (ms)', txid, getUnixTs() - startTime)
    return { txid, slot }
}
/**
 * Simualate a transaction.
 * @param connection The connection to the cluster.
 * @param transaction  The transaction to simulate.
 * @param commitment  The commitment to use for the transaction.
 * @returns  The simulated transaction response.
 */
async function simulateTransaction(
    connection: Connection,
    transaction: Transaction,
    commitment: Commitment
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash

    const signData = transaction.serializeMessage()
    const encodedTransaction = signData.toString('base64')
    const config: any = { encoding: 'base64', commitment }
    const args = [encodedTransaction, config]

    // @ts-ignore
    const res = await connection._rpcRequest('simulateTransaction', args)
    if (res.error) {
        throw new Error('failed to simulate transaction: ' + res.error.message)
    }
    return res.result
}
/**
 * Wait for a transaction to be confirmed.
 * @param txid The transaction id to await confirmation for.
 * @param timeout  The timeout in milliseconds.
 * @param connection  The connection to the cluster.
 * @param commitment  The commitment to use for the transaction.
 * @param queryStatus  Whether to query the status of the transaction.
 * @returns  The transaction signature.
 */
export async function awaitTransactionSignatureConfirmation(
    txid: TransactionSignature,
    timeout: number,
    connection: Connection,
    commitment: Commitment = 'recent',
    queryStatus = false
): Promise<SignatureStatus | null | void> {
    let done = false
    let status: SignatureStatus | null | void = {
        slot: 0,
        confirmations: 0,
        err: null,
    }
    let subId = 0
    // eslint-disable-next-line no-async-promise-executor
    status = await new Promise(async (resolve, reject) => {
        setTimeout(() => {
            if (done) {
                return
            }
            done = true
            console.warn('Rejecting for timeout...')
            reject({ timeout: true })
        }, timeout)
        try {
            subId = connection.onSignature(
                txid,
                (result, context) => {
                    done = true
                    status = {
                        err: result.err,
                        slot: context.slot,
                        confirmations: 0,
                    }
                    if (result.err) {
                        console.warn('Rejected via websocket', result.err)
                        reject(status)
                    } else {
                        console.log('Resolved via websocket', result)
                        resolve(status)
                    }
                },
                commitment
            )
        } catch (e) {
            done = true
            console.error('WS error in setup', txid, e)
        }
        while (!done && queryStatus) {
            // eslint-disable-next-line no-loop-func
            ;(async () => {
                try {
                    const signatureStatuses = await connection.getSignatureStatuses([txid])
                    status = signatureStatuses && signatureStatuses.value[0]
                    if (!done) {
                        if (!status) {
                            console.log('REST null result for', txid, status)
                        } else if (status.err) {
                            console.error('REST error for', txid, status)
                            done = true
                            reject(status.err)
                        } else if (!status.confirmations) {
                            console.log('REST no confirmations for', txid, status)
                        } else {
                            console.log('REST confirmation for', txid, status)
                            done = true
                            resolve(status)
                        }
                    }
                } catch (e) {
                    if (!done) {
                        console.error('REST connection error: txid', txid, e)
                    }
                }
            })()
            await sleep(2000)
        }
    })

    //   //@ts-ignore
    //   if (connection._signatureSubscriptions[subId])
    connection.removeSignatureListener(subId)
    done = true
    console.log('Returning status', status)
    return status
}

export enum SequenceType {
    Sequential,
    Parallel,
    StopOnFailure,
}
/**
 * Execute a sequence of transactions.
 * @returns  The transaction signature.
 */
export const sendTransactions = async (
    connection: Connection,
    wallet: any,
    instructionSet: TransactionInstruction[][],
    signersSet: Keypair[][],
    sequenceType: SequenceType = SequenceType.Parallel,
    commitment: Commitment = 'singleGossip',
    successCallback: (txid: string, ind: number) => void = (txid, ind) => {},
    failCallback: (reason: string, ind: number) => boolean = (txid, ind) => false,
    block?: IBlockhashAndFeeCalculator,
    beforeTransactions: Transaction[] = [],
    afterTransactions: Transaction[] = []
): Promise<{ number: number; txs: { txid: string; slot: number }[] }> => {
    if (!wallet.publicKey) throw new Error('Wallet not connected')

    const unsignedTxns: Transaction[] = beforeTransactions

    if (!block) {
        block = await connection.getLatestBlockhash(commitment)
    }

    for (let i = 0; i < instructionSet.length; i++) {
        const instructions = instructionSet[i]
        const signers = signersSet[i]

        if (instructions.length === 0) {
            continue
        }

        let transaction = new Transaction()
        instructions.forEach((instruction) => transaction.add(instruction))
        transaction.recentBlockhash = block.blockhash
        transaction.setSigners(
            // fee payed by the wallet owner
            wallet.publicKey,
            ...signers.map((s) => s.publicKey)
        )

        if (signers.length > 0) {
            transaction.partialSign(...signers)
        }

        unsignedTxns.push(transaction)
    }
    unsignedTxns.push(...afterTransactions)

    const partiallySignedTransactions = unsignedTxns.filter((t) =>
        t.signatures.find((sig) => sig.publicKey.equals(wallet.publicKey))
    )
    const fullySignedTransactions = unsignedTxns.filter(
        (t) => !t.signatures.find((sig) => sig.publicKey.equals(wallet.publicKey))
    )
    let signedTxns = await wallet.signAllTransactions(partiallySignedTransactions)
    signedTxns = fullySignedTransactions.concat(signedTxns)
    const pendingTxns: Promise<{ txid: string; slot: number }>[] = []

    console.log('Signed txns length', signedTxns.length, 'vs handed in length', instructionSet.length)
    for (let i = 0; i < signedTxns.length; i++) {
        const signedTxnPromise = sendSignedTransaction({
            connection,
            signedTransaction: signedTxns[i],
        })

        if (sequenceType !== SequenceType.Parallel) {
            try {
                await signedTxnPromise.then(({ txid, slot }) => successCallback(txid, i))
                pendingTxns.push(signedTxnPromise)
            } catch (e) {
                console.log('Failed at txn index:', i)
                console.log('Caught failure:', e)

                failCallback(signedTxns[i], i)
                if (sequenceType === SequenceType.StopOnFailure) {
                    return {
                        number: i,
                        txs: await Promise.all(pendingTxns),
                    }
                }
            }
        } else {
            pendingTxns.push(signedTxnPromise)
        }
    }

    if (sequenceType !== SequenceType.Parallel) {
        const result = await Promise.all(pendingTxns)
        return { number: signedTxns.length, txs: result }
    }

    return { number: signedTxns.length, txs: await Promise.all(pendingTxns) }
}
