/**
 * Fetch a source file (`wavefile=`, `PWL file=`) from a Nextcloud share on the
 * browser's behalf: <base>/api/remote-file?url=<share link>[&name=<file name>].
 * The name lets the link be a folder share holding that file.
 *
 * Why a detour through the server at all: Nextcloud answers a public share
 * without `Access-Control-Allow-Origin`, so the browser may download the file
 * but the app may not read it. The server has no such restriction.
 *
 * Why not an open proxy: anything that fetches a URL a visitor names is a way
 * into the network the server sits in. Only https, only the hosts listed in
 * LIBRESPICE_REMOTE_HOSTS (comma separated), redirects only to those hosts, and
 * a size cap. The default is the one cloud the published examples use.
 *
 * Used by server/index.mjs and, so `npm run dev` needs no second process, by
 * vite.config.ts.
 */

const ALLOWED_HOSTS = (process.env.LIBRESPICE_REMOTE_HOSTS ?? "cloud.fes-es.de")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const MAX_BYTES = (Number(process.env.LIBRESPICE_REMOTE_MAX_MB) || 50) * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * The WebDAV address of a Nextcloud share link — the one that answers with the
 * file itself rather than the share's web page.
 *
 *   https://host[/index.php]/s/TOKEN[/download]          → /public.php/dav/files/TOKEN
 *   https://host/s/TOKEN/download?path=/sub&files=a.wav   → /public.php/dav/files/TOKEN/sub/a.wav
 *   https://host/public.php/dav/files/TOKEN[/…]           → unchanged
 *
 * Anything else on an allowed host is fetched as given.
 */
export function nextcloudDownloadUrl(link) {
  return downloadCandidates(link, "")[0];
}

/**
 * The addresses to try, in order. A bare share link (`/s/TOKEN`, no `files=`)
 * may be a file or a folder — the link alone does not say which. So when the
 * source names its file, `TOKEN/<name>` is the second try: a file share answers
 * the first (and 404s the second), a folder share the second. The name is only
 * a base name, so it cannot leave the shared folder.
 */
export function downloadCandidates(link, name) {
  const u = new URL(link);
  const share = /^(?:\/index\.php)?\/s\/([A-Za-z0-9]+)(?:\/download)?\/?$/.exec(u.pathname);
  if (!share) return [u];
  const dir = (u.searchParams.get("path") ?? "/").replace(/^\/+|\/+$/g, "");
  const file = u.searchParams.get("files") ?? "";
  const davUrl = (...parts) => {
    const rest = parts.filter(Boolean).map((p) => p.split("/").map(encodeURIComponent).join("/")).join("/");
    return new URL(`/public.php/dav/files/${share[1]}${rest ? `/${rest}` : ""}`, u.origin);
  };
  const base = name.trim().replace(/^"(.*)"$/, "$1").split(/[\\/]/).pop() ?? "";
  const inFolder = !file && base && base !== "." && base !== "..";
  return inFolder ? [davUrl(dir, file), davUrl(dir, base)] : [davUrl(dir, file)];
}

function allowed(u) {
  return u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname.toLowerCase());
}

/** The file name a response offers, from its Content-Disposition. */
function offeredName(res) {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : "";
}

/** Node `(req, res)` handler; `req.url` carries `?url=…`. */
export async function handleRemoteFile(req, res) {
  const fail = (status, msg) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(msg);
  };
  let candidates;
  try {
    const params = new URL(req.url, "http://x").searchParams;
    candidates = downloadCandidates(params.get("url") ?? "", params.get("name") ?? "");
  } catch {
    return fail(400, "Kein gültiger Link");
  }
  if (!allowed(candidates[0])) {
    return fail(403, `Nur https-Links auf ${ALLOWED_HOSTS.join(", ") || "(keinem Host)"} sind freigegeben`);
  }

  try {
    let upstream;
    let problem;
    for (const [i, candidate] of candidates.entries()) {
      let target = candidate;
      for (let hop = 0; ; hop++) {
        upstream = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
        const loc = upstream.headers.get("location");
        if (upstream.status < 300 || upstream.status >= 400 || !loc) break;
        target = new URL(loc, target);
        if (hop >= MAX_REDIRECTS || !allowed(target)) return fail(502, "Weiterleitung auf einen nicht freigegebenen Host");
      }
      const type = upstream.headers.get("content-type") ?? "";
      if (upstream.status === 404 && i > 0) {
        const name = decodeURIComponent(candidate.pathname.split("/").pop());
        problem = [404, `„${name}" liegt nicht im freigegebenen Ordner (Groß-/Kleinschreibung beachten)`];
      } else if (!upstream.ok) problem = [upstream.status === 404 ? 404 : 502, `Nextcloud antwortet ${upstream.status}`];
      // The share's web page instead of the file: a link to a folder, or one
      // that needs a password. A folder may also answer as a listing or a zip.
      else if (/text\/html|unix-directory|application\/zip/.test(type)) {
        problem = [422, "Der Link liefert keine Datei (Ordner ohne passenden Dateinamen unter „Datei\", oder Passwortschutz?)"];
      } else {
        problem = undefined;
        break;
      }
      await upstream.body?.cancel().catch(() => {});
    }
    if (problem) return fail(...problem);
    if (Number(upstream.headers.get("content-length")) > MAX_BYTES) return fail(413, "Datei zu groß");

    const chunks = [];
    let size = 0;
    for await (const chunk of upstream.body) {
      size += chunk.length;
      if (size > MAX_BYTES) return fail(413, "Datei zu groß");
      chunks.push(chunk);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
    const name = offeredName(upstream);
    if (name) res.setHeader("X-File-Name", encodeURIComponent(name));
    // A share's file rarely changes, but it can: a few minutes is enough to
    // spare a reload, short enough that a replaced file shows up soon.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.end(Buffer.concat(chunks));
  } catch (err) {
    fail(504, `Nextcloud nicht erreichbar: ${err.message || err}`);
  }
}
