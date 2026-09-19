import { GitHub, ConflictError } from "./github.js";
import { processImage } from "./images.js";

const JSON_PATH = "artworks.json";
const SETTINGS_KEY = "artwork-editor-settings";
const IMAGE_VERSIONS = ["thumb", "display", "full"];

const $ = (id) => document.getElementById(id);

// ---------- State ----------

let github = null;
let loaded = false;     // true once artworks.json has been read from GitHub
let jsonSha = null;     // version of artworks.json we loaded; used to detect edits made elsewhere
let baseline = [];      // works as they are on GitHub
let works = [];         // works as edited here
let busy = false;
let flash = null;       // { text, kind } shown instead of the normal status
const pending = new Map();  // work id -> processed image waiting to be published
const previews = new Map(); // work id -> object URL for images not live on the site yet
let editing = null;         // { id, slugTouched, image }

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const randomTag = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0")).join("");

const normalize = (work) => ({
  slug: String(work.slug || ""),
  title: String(work.title || ""),
  price: String(work.price || ""),
  medium: String(work.medium || ""),
  size: String(work.size || ""),
  description: String(work.description || ""),
  sold: Boolean(work.sold),
  hidden: Boolean(work.hidden),
  images: work.images && work.images.full ? { ...work.images } : null,
});

const strip = ({ _id, ...work }) => work;
const serialize = (list) => JSON.stringify(list.map(strip), null, 2) + "\n";
const imagePaths = (work) => (work.images ? IMAGE_VERSIONS.map((v) => work.images[v]).filter(Boolean) : []);

// ---------- Settings ----------

const defaultSettings = () => {
  const host = window.location.hostname;
  const onPages = host.endsWith(".github.io");
  return {
    owner: onPages ? host.split(".")[0] : "callablake",
    repo: onPages ? host : "callablake.github.io",
    branch: "main",
    token: "",
  };
};

const loadSettings = () => {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaultSettings();
  }
};

const saveSettings = (settings) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    flash = { text: "This browser won't remember the token (private browsing?). You'll need to paste it again next time.", kind: "error" };
  }
};

let settings = loadSettings();

// ---------- Change tracking ----------

const summarize = () => {
  const base = new Map(baseline.map((w) => [w._id, w]));
  const current = new Set(works.map((w) => w._id));
  const added = works.filter((w) => !base.has(w._id));
  const removed = baseline.filter((w) => !current.has(w._id));
  const updated = works.filter(
    (w) => base.has(w._id) && (pending.has(w._id) || JSON.stringify(strip(w)) !== JSON.stringify(strip(base.get(w._id))))
  );
  const orderNow = works.filter((w) => base.has(w._id)).map((w) => w._id).join();
  const orderBefore = baseline.filter((w) => current.has(w._id)).map((w) => w._id).join();
  const reordered = orderNow !== orderBefore;
  const count = added.length + removed.length + updated.length + (reordered ? 1 : 0);
  return { added, removed, updated, reordered, count };
};

const isDirty = () => summarize().count > 0;

const commitMessage = ({ added, removed, updated, reordered }) => {
  const names = (list, verb) => {
    if (list.length === 0) return null;
    if (list.length > 3) return `${verb} ${list.length} works`;
    return `${verb} ${list.map((w) => `"${w.title}"`).join(", ")}`;
  };
  const parts = [names(added, "add"), names(removed, "remove"), names(updated, "update"), reordered && "reorder works"];
  return "Editor: " + parts.filter(Boolean).join("; ");
};

// ---------- Rendering ----------

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  children.forEach((child) => child && node.append(child));
  return node;
};

const thumbSrc = (work) => previews.get(work._id) || (work.images ? `../${work.images.thumb}` : "");

const setStatus = (text, kind = "") => {
  const status = $("status");
  status.textContent = text;
  status.className = `status ${kind ? "is-" + kind : ""}`;
};

const render = () => {
  const summary = summarize();

  if (flash) setStatus(flash.text, flash.kind);
  else if (!github) setStatus("Not connected. Open Connection settings to add your GitHub token.");
  else if (!loaded) setStatus("Connecting…");
  else if (summary.count) setStatus(`${summary.count} unpublished change${summary.count === 1 ? "" : "s"}.`, "pending");
  else setStatus("Everything is published.");

  $("publish").disabled = busy || !github || !loaded || summary.count === 0;
  $("reload").disabled = busy || !github;

  const base = new Map(baseline.map((w) => [w._id, w]));
  const list = $("works");
  list.replaceChildren();
  $("empty").hidden = works.length > 0;

  works.forEach((work, index) => {
    const tags = [];
    if (!base.has(work._id)) tags.push(["New", "new"]);
    else if (summary.updated.includes(work)) tags.push(["Edited", "new"]);
    if (!work.images && !pending.has(work._id)) tags.push(["Needs image", "warn"]);
    if (work.sold) tags.push(["Sold", ""]);
    if (work.hidden) tags.push(["Hidden", ""]);

    const button = (text, label, onClick, disabled = false) =>
      el("button", { type: "button", className: "icon-button", textContent: text, disabled: disabled || busy, onclick: onClick, title: label, ariaLabel: label });

    const src = thumbSrc(work);
    list.append(
      el("li", { className: "work" }, [
        src ? el("img", { src, alt: "", loading: "lazy" }) : el("div", { className: "no-image" }),
        el("div", { className: "work-text" }, [
          el("strong", { textContent: work.title || "Untitled" }),
          el("span", { className: "muted", textContent: [work.price, work.slug].filter(Boolean).join(" · ") }),
          tags.length
            ? el("span", { className: "tags" }, tags.map(([text, kind]) => el("span", { className: `tag ${kind}`, textContent: text })))
            : null,
        ]),
        el("div", { className: "work-buttons" }, [
          button("↑", "Move up", () => move(index, -1), index === 0),
          button("↓", "Move down", () => move(index, 1), index === works.length - 1),
          button("Edit", `Edit ${work.title}`, () => openEditor(work)),
          button("Delete", `Delete ${work.title}`, () => remove(work)),
        ]),
      ])
    );
  });
};

const changed = () => {
  flash = null;
  render();
};

// ---------- List actions ----------

const move = (index, delta) => {
  const [work] = works.splice(index, 1);
  works.splice(index + delta, 0, work);
  changed();
};

const forgetPreview = (id) => {
  if (previews.has(id)) URL.revokeObjectURL(previews.get(id));
  previews.delete(id);
};

const remove = (work) => {
  if (!confirm(`Remove "${work.title}" from the site?\n\nIts images will be deleted when you publish.`)) return;
  works = works.filter((w) => w !== work);
  pending.delete(work._id);
  forgetPreview(work._id);
  changed();
};

// ---------- Edit dialog ----------

const slugify = (text) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const uniqueSlug = (base, exceptId) => {
  const root = base || "untitled";
  let slug = root;
  for (let n = 2; works.some((w) => w._id !== exceptId && w.slug === slug); n++) slug = `${root}-${n}`;
  return slug;
};

const showSlugPreview = () => {
  $("slug-preview").textContent = `artwork.html?slug=${$("f-slug").value}`;
  $("slug-auto").hidden = !editing.slugTouched;
};

const kb = (blob) => `${Math.max(1, Math.round(blob.size / 1024))} KB`;

const openEditor = (work) => {
  editing = { id: work ? work._id : null, slugTouched: Boolean(work), image: null, previewUrl: null };
  $("dialog-title").textContent = work ? "Edit work" : "Add work";
  $("f-title").value = work ? work.title : "";
  $("f-slug").value = work ? work.slug : "";
  $("f-price").value = work ? work.price : "";
  $("f-medium").value = work ? work.medium : "";
  $("f-size").value = work ? work.size : "";
  $("f-description").value = work ? work.description : "";
  $("f-sold").checked = work ? work.sold : false;
  $("f-hidden").checked = work ? work.hidden : false;
  $("image").value = "";
  $("form-error").textContent = "";
  $("image-status").textContent = "";
  $("save").disabled = false;

  const src = work ? thumbSrc(work) : "";
  $("preview").hidden = !src;
  $("preview").src = src;
  $("image-label").textContent = src ? "Replace image" : "Choose image";

  showSlugPreview();
  $("dialog").showModal();
  if (!work) $("f-title").focus();
};

$("f-title").addEventListener("input", () => {
  if (!editing.slugTouched) {
    $("f-slug").value = uniqueSlug(slugify($("f-title").value), editing.id);
    showSlugPreview();
  }
});

$("f-slug").addEventListener("input", () => {
  editing.slugTouched = true;
  showSlugPreview();
});

$("f-slug").addEventListener("change", () => {
  $("f-slug").value = slugify($("f-slug").value);
  showSlugPreview();
});

$("slug-auto").addEventListener("click", () => {
  editing.slugTouched = false;
  $("f-slug").value = uniqueSlug(slugify($("f-title").value), editing.id);
  showSlugPreview();
});

$("image").addEventListener("change", async () => {
  const file = $("image").files[0];
  if (!file) return;
  const session = editing;
  $("save").disabled = true;
  $("form-error").textContent = "";
  $("image-status").textContent = "Preparing image…";
  try {
    const image = await processImage(file);
    if (editing !== session) return; // dialog was closed meanwhile
    if (session.previewUrl) URL.revokeObjectURL(session.previewUrl);
    session.image = image;
    session.previewUrl = URL.createObjectURL(image.versions.display.blob);
    $("preview").src = session.previewUrl;
    $("preview").hidden = false;
    $("image-label").textContent = "Replace image";
    const { thumb, display, full } = image.versions;
    $("image-status").textContent =
      `${image.width} × ${image.height}px — gallery ${kb(thumb.blob)}, page ${kb(display.blob)}, full size ${kb(full.blob)}`;
  } catch (error) {
    if (editing === session) {
      $("image-status").textContent = "";
      $("form-error").textContent = error.message;
    }
  } finally {
    if (editing === session) $("save").disabled = false;
  }
});

$("work-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = $("f-title").value.trim();
  const slug = slugify($("f-slug").value);
  const existing = works.find((w) => w._id === editing.id);

  let problem = "";
  if (!title) problem = "Please enter a title.";
  else if (!slug) problem = "Please enter a web address (letters, numbers and dashes).";
  else if (works.some((w) => w._id !== editing.id && w.slug === slug)) problem = `Another work already uses the address "${slug}".`;
  else if (!existing && !editing.image) problem = "Please choose an image.";
  if (problem) {
    $("form-error").textContent = problem;
    return;
  }

  const fields = {
    slug,
    title,
    price: $("f-price").value.trim(),
    medium: $("f-medium").value.trim(),
    size: $("f-size").value.trim(),
    description: $("f-description").value.trim(),
    sold: $("f-sold").checked,
    hidden: $("f-hidden").checked,
  };

  let id = editing.id;
  if (existing) {
    Object.assign(existing, fields);
  } else {
    id = newId();
    works.push({ ...fields, images: null, _id: id });
  }

  if (editing.image) {
    pending.set(id, editing.image);
    forgetPreview(id);
    previews.set(id, editing.previewUrl);
    editing.previewUrl = null; // now owned by previews
  }

  $("dialog").close();
  changed();
});

$("cancel").addEventListener("click", () => $("dialog").close());

$("dialog").addEventListener("close", () => {
  if (editing && editing.previewUrl) URL.revokeObjectURL(editing.previewUrl);
  editing = null;
});

$("add").addEventListener("click", () => openEditor(null));

// ---------- GitHub ----------

const confirmDiscard = (what) =>
  !isDirty() || confirm(`You have unpublished changes. ${what} will discard them.\n\nContinue?`);

const loadFromGitHub = async () => {
  loaded = false;
  render();
  const { data, sha } = await github.readJson(JSON_PATH);
  baseline = (Array.isArray(data) ? data : []).map((w) => ({ ...normalize(w), _id: newId() }));
  works = structuredClone(baseline);
  jsonSha = sha;
  loaded = true;
  pending.clear();
  [...previews.keys()].forEach(forgetPreview);
};

const connect = async () => {
  github = settings.token ? new GitHub(settings) : null;
  loaded = false;
  flash = null;
  if (!github) {
    $("connection").open = true;
    render();
    return;
  }
  try {
    render();
    await github.checkAccess();
    await loadFromGitHub();
    $("connection").open = false;
  } catch (error) {
    flash = { text: error.message, kind: "error" };
    $("connection").open = true;
  }
  render();
};

$("connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!confirmDiscard("Reconnecting")) return;
  settings = {
    token: $("token").value.trim(),
    owner: $("owner").value.trim(),
    repo: $("repo").value.trim(),
    branch: $("branch").value.trim() || "main",
  };
  saveSettings(settings);
  connect();
});

$("forget").addEventListener("click", () => {
  settings.token = "";
  $("token").value = "";
  saveSettings(settings);
  github = null;
  loaded = false;
  flash = { text: "Token removed from this browser." };
  render();
});

$("reload").addEventListener("click", async () => {
  if (!confirmDiscard("Reloading")) return;
  flash = null;
  try {
    await loadFromGitHub();
  } catch (error) {
    flash = { text: error.message, kind: "error" };
  }
  render();
});

const publishProblems = () => {
  const problems = [];
  const seen = new Set();
  works.forEach((w) => {
    if (!w.images && !pending.has(w._id)) problems.push(`"${w.title}" needs an image.`);
    if (seen.has(w.slug)) problems.push(`More than one work uses the address "${w.slug}".`);
    seen.add(w.slug);
  });
  return problems;
};

$("publish").addEventListener("click", async () => {
  const problems = publishProblems();
  if (problems.length) {
    flash = { text: problems.join(" "), kind: "error" };
    render();
    return;
  }

  busy = true;
  render();

  const summary = summarize();
  const uploads = [];
  const finalWorks = works.map((work) => {
    const image = pending.get(work._id);
    if (!image) return work;
    const base = `art/${work.slug}-${randomTag()}`;
    const images = {};
    IMAGE_VERSIONS.forEach((name) => {
      const { blob, ext } = image.versions[name];
      images[name] = `${base}-${name}.${ext}`;
      uploads.push({ path: images[name], blob });
    });
    return { ...work, images: { ...images, width: image.width, height: image.height } };
  });

  // Images that were on the site but are no longer used by any work
  const keep = new Set(finalWorks.flatMap(imagePaths));
  const deletions = [...new Set(baseline.flatMap(imagePaths))].filter((p) => p.startsWith("art/") && !keep.has(p));

  try {
    const result = await github.commit({
      uploads,
      textFiles: [{ path: JSON_PATH, text: serialize(finalWorks) }],
      deletions,
      guard: { path: JSON_PATH, sha: jsonSha },
      message: commitMessage(summary),
      onProgress: (text) => setStatus(text, "pending"),
    });
    works = finalWorks;
    baseline = structuredClone(works);
    jsonSha = result.shas[JSON_PATH];
    pending.clear(); // previews stay so new thumbnails show until the site finishes updating
    flash = { text: "Published! The live site will update in about a minute.", kind: "success" };
  } catch (error) {
    if (error instanceof ConflictError) {
      flash = {
        text: "The artwork list on GitHub was changed somewhere else (another device?) since you loaded it. Use Export JSON to keep a copy of your changes, then Reload from GitHub.",
        kind: "error",
      };
    } else {
      flash = { text: error.message, kind: "error" };
    }
  } finally {
    busy = false;
    render();
  }
});

// ---------- Import / export ----------

$("import").addEventListener("change", async () => {
  const file = $("import").files[0];
  $("import").value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!Array.isArray(data) || data.some((w) => typeof w !== "object" || !w || !w.title)) throw new Error();
  } catch {
    flash = { text: "That file isn't a valid artworks JSON file.", kind: "error" };
    render();
    return;
  }
  if (!confirmDiscard("Importing")) return;

  // Match imported works to published ones by image so they count as edits, not remove + add
  const byImage = new Map(baseline.filter((w) => w.images).map((w) => [w.images.full, w._id]));
  works = data.map((w) => {
    const work = normalize(w);
    return { ...work, _id: (work.images && byImage.get(work.images.full)) || newId() };
  });
  pending.clear();
  [...previews.keys()].forEach(forgetPreview);
  flash = { text: `Imported ${works.length} works. Press Publish to put them on the site.`, kind: "pending" };
  render();
});

$("export").addEventListener("click", () => {
  if (pending.size && !confirm("Images you've added since the last publish aren't included in the export — publish first to keep them.\n\nExport anyway?")) return;
  const exported = works.map((w) => (pending.has(w._id) && !w.images ? { ...w, images: null } : w));
  const url = URL.createObjectURL(new Blob([serialize(exported)], { type: "application/json" }));
  const link = el("a", { href: url, download: `artworks-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- Start ----------

window.addEventListener("beforeunload", (event) => {
  if (isDirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

$("token").value = settings.token;
$("owner").value = settings.owner;
$("repo").value = settings.repo;
$("branch").value = settings.branch;
connect();
