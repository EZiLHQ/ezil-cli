import { test, expect } from "bun:test";
import { branchRef, canonicalRepository, validatePrivateGrant, readPrivateGrant } from "./private-grant-v2";
const url = "https://github.ezil.work/acme/repo.git";
const now = Date.parse("2026-11-10T17:00:00.000Z");
const packet = () => ({version:2, repository:{id:"cf-repo-fixture", canonicalURL:url, ref:"refs/heads/topic"}, identity:{issuer:"https://id.ezil.work/" as const, subject:"auth0|fixture"}, git:{username:"ezil", token:"v2_synthetic_opaque_token", expiresAt:new Date(now+60000).toISOString(), scope:"read"}});

test("strict v2 preserves Cloudflare ID, exact identity, branch and declared scope without Works fields", () => {
 for (const scope of ["read", "write"] as const) {
  const p = packet(); p.git.scope = scope;
  const result = validatePrivateGrant(p, url, now);
  expect(result.repository).toEqual(p.repository); expect(result.identity).toEqual(p.identity);
  expect(result.grant.password).toBe(p.git.token); expect(result.grant.scope).toBe(scope);
  expect(result).not.toHaveProperty("accountId"); expect(result).not.toHaveProperty("binding");
 }
});
test("native Artifacts HTTP Basic passwords preserve the opaque expiry suffix", () => {
 const token = "art_v1_" + "a".repeat(40) + "?expires=" + Math.floor((now + 60000) / 1000);
 for (const scope of ["read", "write"] as const) {
  const p = packet(); p.git.token = token; p.git.scope = scope;
  const grant = validatePrivateGrant(p, url, now).grant;
  expect(grant.password).toBe(token); expect(grant.scope).toBe(scope);
  expect(grant.password_expiry_utc).toBe(Math.floor((now + 60000) / 1000));
 }
});
test("native-format passwords still reject controls, whitespace, colon and size violations", () => {
 const token = "art_v1_" + "b".repeat(40) + "?expires=" + Math.floor((now + 60000) / 1000);
 for (const bad of [token + ":password", token + "\n", token + "\r", token + "\t", token + " ", token + "\0", token + "\x7f", token + "\u2028", token + "\u2029", token + "é", token + ";", token + "&admin=true", "a".repeat(15), "a".repeat(8193)]) {
  const p = packet(); p.git.token = bad;
  expect(() => validatePrivateGrant(p, url, now)).toThrow();
 }
});
test("every v2 boundary rejects substitution, unknown fields, unsafe credentials and expired or overlong grants", () => {
 const p = packet();
 const invalid: unknown[] = [null, [], {...p, version:1}, {...p, binding:{}}, {...p, repository:{...p.repository, projectId:"fake"}}, {...p, identity:{...p.identity, accountId:"fake"}},
  {...p, repository:{...p.repository, canonicalURL:url+"/"}}, {...p, repository:{...p.repository, id:""}}, {...p, repository:{...p.repository, ref:"refs/tags/topic"}},
  {...p, identity:{...p.identity, issuer:"https://other.invalid/"}}, {...p, identity:{...p.identity, subject:""}},
  ...["", "short", "x".repeat(8193), "v2_synthetic_token\n", "v2_synthetic_token\u2028", "v2_synthetic_token\u2029", "v2_secret\npassword=evil", "v2_secret\rmalicious", "v2_secret\0invalid", "v2_token with space"].map(token=>({...p,git:{...p.git,token}})),
  ...["admin", "READ", ""].map(scope=>({...p,git:{...p.git,scope}})),
  ...[new Date(now).toISOString(),new Date(now-1).toISOString(),new Date(now+300001).toISOString(), "not-a-date", "2026-11-10", "2026-11-10T18:00:00+01:00"].map(expiresAt=>({...p,git:{...p.git,expiresAt}})),
  {...p,git:{...p.git,username:"other"}}, {...p,git:{...p.git,extra:true}}];
 for (const value of invalid) expect(()=>validatePrivateGrant(value,url,now)).toThrow();
 expect(()=>validatePrivateGrant(p,"https://github.ezil.work/acme/other.git",now)).toThrow();
});
test("canonical URLs refuse parser normalization and alternate destinations", () => {
 expect(canonicalRepository(url)).toBe(true);
 for (const bad of [url+"/",url+"?x=1",url+"#x",url+".git",url.replace("https:","http:"),url.replace("github.","user:pass@github."),url.replace(".work/", ".work:443/"),url.replace("acme", "Acme"),url.replace("repo.git", "../repo.git"),url.replace("repo.git", "%72epo.git"),url.replace("repo.git", "x...git"),url.replace("repo.git", "repo.git\n"),url.replace("github.ezil.work", "github.ezil.work.attacker.invalid")]) expect(canonicalRepository(bad)).toBe(false);
});
test("full branch refs exclude revision expressions and ambiguous or unsafe Git refs", () => {
 expect(branchRef("refs/heads/feature/topic-1.2")).toBe(true);
 for (const ref of ["main","HEAD","refs/tags/topic","refs/heads/../x","refs/heads/a//b","refs/heads/.x","refs/heads/a.lock","refs/heads/a.","refs/heads/a/","refs/heads/a@{1}","refs/heads/a~1","refs/heads/a:b","refs/heads/a b","refs/heads/topic\n","refs/heads/topic\u2028","refs/heads/"+"a".repeat(255)]) expect(branchRef(ref)).toBe(false);
});
test("private reader refuses stdin and arbitrary inherited descriptors", async () => {
 for(const fd of [0,1,2,4,-1,NaN]) await expect(readPrivateGrant(fd)).rejects.toThrow();
});
