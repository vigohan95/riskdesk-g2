// The real SDK, except that waitForEvenAppBridge resolves to the browser lens instead of the Even App.
export * from 'even-hub-sdk-real'
import { lensReady } from './boot.ts'
export async function waitForEvenAppBridge() { return (await lensReady).bridge() }
