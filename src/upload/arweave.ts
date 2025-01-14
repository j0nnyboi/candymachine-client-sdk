import { calculate } from '@j0nnyboi/arweave-cost'
import * as anchor from '@j0nnyboi/anchor'
import { ARWEAVE_PAYMENT_WALLET, ARWEAVE_UPLOAD_ENDPOINT,JSON_EXTENSION } from '../constants'
import { Manifest } from '../types'
import { getFileExtension } from './helpers'
import { sendTransactionWithRetryWithKeypair } from './transactions'

/**
 * @param fileSizes - array of file sizes
 * @returns {Promise<number>} - estimated cost to store files in lamports
 */
async function fetchAssetCostToStore(fileSizes: number[]): Promise<number> {
    const result = await calculate(fileSizes)
    console.log('Arweave cost estimates:', result)

    return result.safecoin * anchor.web3.LAMPORTS_PER_SAFE
}

/**
 * After doing a tx to the metaplex arweave wallet to store the NFTs and their metadata, this function calls a serverless function from metaplex
 * in which the files to upload are attached to the http form.
 * @param data - FormData object
 * @param manifest json manifest containing metadata
 * @param index index of the NFTs to upload
 * @returns http response
 */
async function upload(data: FormData, manifest: Manifest, index: number) {
    console.log(`trying to upload image ${index}: ${manifest.name}`)
    const res = await (
        await fetch(ARWEAVE_UPLOAD_ENDPOINT, {
            method: 'POST',
            body: data,
        })
    ).json()
    return res
}

function estimateManifestSize(filenames: string[]) {
    const paths: { [key: string]: any } = {}
    for (const name of filenames) {
        console.log('name', name)
        paths[name] = {
            id: 'artestaC_testsEaEmAGFtestEGtestmMGmgMGAV438',
            ext: getFileExtension(name),
        }
    }

    const manifest = {
        manifest: 'arweave/paths',
        version: '0.1.0',
        paths,
        index: {
            path: 'metadata.json',
        },
    }

    const data = Buffer.from(JSON.stringify(manifest), 'utf8')
    console.log('Estimated manifest size:', data.length)
    return data.length
}
/**
 * Upload the NFTs and their metadata to the Arweave network.
 * @param walletKeyPair - keypair of the wallet to use for the mint transaction
 * @param anchorProgram  - anchor program to use for the mint transaction
 * @param env  - environment to use for the mint transaction (mainnet-beta, devnet, testnet)
 * @param image  - image to upload
 * @param manifestBuffer  - buffer of the manifest to upload
 * @param manifest  - manifest to upload
 * @param index  - index of the image to upload
 * @returns  - The links for the manifest and the image in Arweave.
 */
export async function arweaveUpload(
    walletKeyPair: any,
    anchorProgram: anchor.Program,
    env: string,
    image: File,
    manifestBuffer: Buffer,
    manifest: Manifest,
    index: number
) {
    const imageExt = image.type
    const estimatedManifestSize = estimateManifestSize([image.name, 'metadata.json'])

    const storageCost = await fetchAssetCostToStore([image.size, manifestBuffer.length, estimatedManifestSize])

    console.log(`lamport cost to store ${image.name}: ${storageCost}`)

    const instructions = [
        anchor.web3.SystemProgram.transfer({
            fromPubkey: walletKeyPair.publicKey,
            toPubkey: ARWEAVE_PAYMENT_WALLET,
            lamports: Math.round(storageCost),
        }),
    ]

    const tx = await sendTransactionWithRetryWithKeypair(
        anchorProgram.provider.connection,
        walletKeyPair,
        instructions,
        'confirmed'
    )
    console.log(`solana transaction (${env}) for arweave payment:`, tx)

    const data = new FormData()
    const manifestBlob = new Blob([manifestBuffer], { type: JSON_EXTENSION })

    data.append('transaction', tx['txid'])
    data.append('env', env)
    data.append('file[]', image, image.name)
    data.append('file[]', manifestBlob, 'metadata.json')

    const result = await upload(data, manifest, index)

    console.log('result', result)

    const metadataFile = result.messages?.find((m: any) => m.filename === 'manifest.json')
    const imageFile = result.messages?.find((m: any) => m.filename === image.name)

    if (metadataFile?.transactionId) {
        const link = `https://arweave.net/${metadataFile.transactionId}`
        const imageLink = `https://arweave.net/${imageFile.transactionId}?ext=${imageExt.replace('.', '')}`
        console.log(`File uploaded: ${link}`)
        console.log(`imageLink uploaded: ${imageLink}`)

        return [link, imageLink]
    } else {
        // @todo improve
        throw new Error(`No transaction ID for upload: ${index}`)
    }
}
