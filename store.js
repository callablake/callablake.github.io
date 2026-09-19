const gallery = document.querySelector(".gallery");

const showMessage = (text) => {
  const message = document.createElement("p");
  message.className = "muted";
  message.textContent = text;
  gallery.appendChild(message);
};

const buildGallery = (works) => {
  if (works.length === 0) {
    showMessage("No works available right now. Please check back soon.");
    return;
  }

  works.forEach((art) => {
    const link = document.createElement("a");
    link.className = "piece";
    link.href = `artwork.html?slug=${encodeURIComponent(art.slug)}`;

    const figure = document.createElement("figure");

    const img = document.createElement("img");
    img.src = art.images.thumb;
    img.alt = `${art.title} painting`;
    // Reserving the aspect ratio stops the columns from jumping as images load
    img.width = art.images.width;
    img.height = art.images.height;
    img.loading = "lazy";
    img.decoding = "async";

    const caption = document.createElement("figcaption");

    const title = document.createElement("span");
    title.className = "piece-title";
    title.textContent = art.title;

    const price = document.createElement("span");
    price.className = art.sold ? "price sold" : "price";
    price.textContent = art.sold ? "Sold" : art.price || "";

    caption.appendChild(title);
    caption.appendChild(price);
    figure.appendChild(img);
    figure.appendChild(caption);
    link.appendChild(figure);
    gallery.appendChild(link);
  });
};

window.loadArtworks()
  .then(buildGallery)
  .catch(() => showMessage("The gallery couldn't be loaded. Please try again later."));
