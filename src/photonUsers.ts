// Photon's free/shared plan only delivers to numbers listed under Users in the dashboard.
// If you've run `npx -p @photon-ai/cli photon login` once (or set PHOTON_TOKEN), the court adds each
// household number for you, so nobody has to type them into the dashboard by hand.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = process.env.PHOTON_API_HOST ?? "https://app.photon.codes";

/** The Photon CLI's saved login (~/.config/photon/**.json with an accessToken), or PHOTON_TOKEN. */
export function dashboardToken(): string | undefined {
  if (process.env.PHOTON_TOKEN) return process.env.PHOTON_TOKEN;
  const roots = [
    process.env.PHOTON_CONFIG_DIR,
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, "photon"),
    join(homedir(), ".config", "photon"),
  ].filter(Boolean) as string[];
  const found: { token: string; at: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith(".json")) {
        try {
          const j = JSON.parse(readFileSync(p, "utf8"));
          if (typeof j.accessToken === "string" && (!j.apiUrl || String(j.apiUrl).startsWith(API))) found.push({ token: j.accessToken, at: st.mtimeMs });
        } catch {}
      }
    }
  };
  roots.forEach((r) => walk(r, 0));
  return found.sort((a, b) => b.at - a.at)[0]?.token;
}

/** Add a phone/email to the project's Users. Resolves "added" | "exists"; throws with a readable message. */
export async function addPhotonUser(name: string, handle: string): Promise<"added" | "exists"> {
  const token = dashboardToken();
  const projectId = process.env.PHOTON_PROJECT_ID;
  if (!token || !projectId) throw new Error("no-token");
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const body: Record<string, unknown> = { firstName: firstName || name, lastName: rest.join(" ") || undefined, sendInvite: false };
  if (handle.includes("@")) body.email = handle;
  else body.phoneNumber = handle;
  const res = await fetch(`${API}/api/projects/${projectId}/spectrum/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (res.ok) return "added";
  if (res.status === 409 || /already|exists|duplicate/i.test(text)) return "exists";
  if (res.status === 401) throw new Error("Your Photon login expired. Run `npx -p @photon-ai/cli photon login` again.");
  throw new Error(`Photon said ${res.status}: ${text.slice(0, 160)}`);
}
