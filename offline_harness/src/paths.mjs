import path from 'node:path';
export const DATA_ROOT=path.resolve(process.env.MINI_CTF_DATA??'.mini-ctf');
export const CONFIG_FILE=process.env.MINI_CTF_CONFIG??path.join(DATA_ROOT,'config.json');
