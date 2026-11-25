// The desk code imports a few Node modules at the top of shared files. In the browser demo nothing calls them
// (stores are injected), so they only have to exist.
const no = () => { throw new Error('not available in the browser demo') }
export const readFileSync = no, writeFileSync = no, mkdirSync = no
export const existsSync = () => false
export const dirname = (p: string) => p.replace(/[\/][^\/]*$/, '')
export const randomUUID = () => crypto.randomUUID()
