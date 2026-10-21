import { WhoamiResponseSchema } from "@ezil/cli-contract/cli-api";

import { accessToken, api, apiOriginOf, type Io } from "../../core/session";

/** Select an accessible repository, then let stock Git use the configured credential helper. */
export async function clone(io: Io, repository?: string): Promise<number> {
	const live = await accessToken(io);
	if (!live) { io.err("Not signed in. Run `ezil auth login`."); return 1; }
	const parsed = WhoamiResponseSchema.safeParse(await api(io, apiOriginOf(io.env), "/cli/whoami", { token: live.token }));
	if (!parsed.success) { io.err("EZiL returned an invalid repository list."); return 1; }
	const repositories = parsed.data.repositories;
	const routeName = (url: string) => new URL(url).pathname.split("/")[2]!.slice(0, -4);
	const name = repository?.toLowerCase();
	const matches = name === undefined ? repositories : repositories.filter(r => routeName(r.cloneUrl).toLowerCase() === name || r.project.toLowerCase() === name);
	if (matches.length !== 1) {
		io.err(matches.length > 1 ? "Choose one repository with `ezil clone <repository>`." : "No matching repository. Available repositories:");
		if (repositories.length === 0) io.out("No repositories yet.");
		for (const r of repositories) io.out(`  ${routeName(r.cloneUrl)}  (${r.project})  ${r.cloneUrl}`);
		return 2;
	}
	const selected = matches[0]!;
	const result = io.run(["git", "clone", selected.cloneUrl]);
	if (result.code !== 0) { io.err("Could not clone the repository. Check Git and your repository access, then try again."); return 1; }
	const dir = routeName(selected.cloneUrl);
	io.out(`Cloned into ${dir}.`);
	io.out(`Next: cd ${dir} && git push`);
	return 0;
}
