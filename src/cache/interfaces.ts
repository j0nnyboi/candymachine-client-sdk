import { BN } from '@j0nnyboi/anchor'
import { NumberToString } from '../types'

export interface ICache {
    authority?: string
    program: {
        uuid: string
        candyMachine: string
    }
    items: Record<
        NumberToString<number | string>,
        {
            link: string
            imageLink: string
            name: string
            onChain: boolean
            verifyRun?: boolean
        }
    >

    startDate: BN | null
    env: string
    cacheName: string
}
