import { createReadStream, fstatSync } from 'node:fs';

/** Only an anonymous pipe/socket inherited from the authenticated OS supervisor. */
export async function readPrivateGrant(fd: number, signal?: AbortSignal): Promise<unknown> {
    if (fd !== 3) throw new Error('invalid private descriptor');
    const stat = fstatSync(fd);
    if (!stat.isFIFO() && !stat.isSocket()) throw new Error('private input must be a pipe');
    const stream = createReadStream('', { fd, autoClose: true, signal });
    const timer = setTimeout(() => stream.destroy(new Error('private input timed out')), 5000);
    let raw = '';
    try {
        for await (const chunk of stream) {
            raw += chunk.toString();
            if (Buffer.byteLength(raw) > 16384) throw new Error('private input too large');
        }
        return JSON.parse(raw);
    } finally { clearTimeout(timer); stream.destroy(); }
}
const exact = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function validatePrivateGrant(value: any, canonicalUrl: string, now = Date.now()) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!exact(value, ['version', 'binding', 'identity', 'git']) || value.version !== 1
        || !exact(value.binding, ['projectId', 'repositoryId', 'canonicalURL', 'ref', 'bindingVersion'])
        || !uuid.test(value.binding.projectId) || !uuid.test(value.binding.repositoryId)
        || value.binding.canonicalURL !== canonicalUrl || !/^[a-f0-9]{64}$/.test(value.binding.bindingVersion)
        || typeof value.binding.ref !== 'string' || value.binding.ref.length > 255
        || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value.binding.ref)
        || value.binding.ref.includes('..') || value.binding.ref.includes('//') || value.binding.ref.endsWith('/')
        || value.binding.ref.split('/').some((p: string) => p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))
        || !exact(value.identity, ['issuer', 'subject']) || value.identity.issuer !== 'https://id.ezil.work/'
        || typeof value.identity.subject !== 'string' || !value.identity.subject || value.identity.subject.length > 255
        || !exact(value.git, ['username', 'token', 'expiresAt', 'scope']) || value.git.username !== 'ezil' || value.git.scope !== 'read'
        || typeof value.git.token !== 'string' || !/^egg_[A-Za-z0-9._~-]+$/.test(value.git.token) || value.git.token.length > 8192
        || typeof value.git.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.git.expiresAt))
        || Date.parse(value.git.expiresAt) <= now || Date.parse(value.git.expiresAt) > now + 300000) throw new Error('invalid private grant');
    return { identity: value.identity as {issuer: string; subject: string},
        grant: { username: 'ezil' as const, scope: 'read' as const, password: value.git.token as string, password_expiry_utc: Math.floor(Date.parse(value.git.expiresAt) / 1000) } };
}
