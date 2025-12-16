const gallery = document.querySelector(".gallery");

const buildGallery = () => {
  if (!Array.isArray(window.ARTWORKS) || window.ARTWORKS.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No works available right now. Please check back soon.";
    gallery.appendChild(empty);
    return;
  }

  window.ARTWORKS.forEach((art) => {
    const link = document.createElement("a");
    link.className = "piece";
    link.href = `artwork.html?slug=${encodeURIComponent(art.slug)}`;

    const figure = document.createElement("figure");

    const img = document.createElement("img");
    img.src = art.image;
    img.alt = `${art.title} painting`;

    const caption = document.createElement("figcaption");
    caption.textContent = art.title;

    figure.appendChild(img);
    figure.appendChild(caption);
    link.appendChild(figure);
    gallery.appendChild(link);
  });
};

buildGallery();
