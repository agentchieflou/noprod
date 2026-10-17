// The file handle of the open project, so Save writes back in place
// (File System Access API; other browsers download a copy instead).
let handle: any = null;

export const getFileHandle = () => handle;
export const setFileHandle = (h: any) => { handle = h; };
export const forgetFileHandle = () => { handle = null; };
