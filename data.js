// Shared loader for artworks.json (managed with the editor in /editor/).
// "no-cache" makes the browser re-check with GitHub Pages, so newly published
// changes show up without waiting for the cache to expire.
window.loadArtworks = async () => {
  const response = await fetch("artworks.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load artworks (${response.status})`);
  const works = await response.json();
  return works.filter((work) => !work.hidden);
};
