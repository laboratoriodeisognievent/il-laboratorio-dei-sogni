// NUMERO WHATSAPP DEL LABORATORIO
// Inserisci il numero completo con prefisso 39,
// senza spazi, senza + e senza trattini.
const whatsappNumber = "39INSERISCIILNUMERO";

// Recupera il carrello salvato nel browser
let cart = [];

try {
  cart = JSON.parse(localStorage.getItem("laboratorioCart")) || [];
} catch (error) {
  cart = [];
}

// Salva il carrello
function saveCart() {
  localStorage.setItem("laboratorioCart", JSON.stringify(cart));
}

// Mostra il contenuto del carrello
function renderCart() {
  const cartContainer = document.getElementById("cart-items");

  if (!cartContainer) return;

  if (cart.length === 0) {
    cartContainer.innerHTML = '<p class="cart-empty">Il carrello è vuoto.</p>';
    return;
  }

  cartContainer.innerHTML = "";

  cart.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "cart-item";

    const description = document.createElement("div");

    const title = document.createElement("strong");
    title.textContent = item.product;

    const details = document.createElement("p");
    details.textContent =
      "Colore: " + item.color +
      (item.name ? " · Nome: " + item.name : "");

    description.appendChild(title);
    description.appendChild(details);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-item";
    removeButton.textContent = "Rimuovi";

    removeButton.addEventListener("click", () => {
      cart.splice(index, 1);
      saveCart();
      renderCart();
    });

    row.appendChild(description);
    row.appendChild(removeButton);
    cartContainer.appendChild(row);
  });
}

// Aggiunge un prodotto al carrello
document.querySelectorAll(".add-to-cart").forEach(button => {
  button.addEventListener("click", () => {
    const colorField = document.getElementById(button.dataset.color);
    const nameField = document.getElementById(button.dataset.name);

    const product = button.dataset.product;
    const color = colorField ? colorField.value : "Da concordare";
    const name = nameField ? nameField.value.trim() : "";

    cart.push({
      product: product,
      color: color,
      name: name
    });

    saveCart();
    renderCart();

    document.getElementById("carrello").scrollIntoView({
      behavior: "smooth"
    });
  });
});

// Invia la richiesta tramite WhatsApp
document.getElementById("send-order").addEventListener("click", () => {
  if (cart.length === 0) {
    alert("Il carrello è vuoto. Aggiungi prima un prodotto.");
    return;
  }

  if (whatsappNumber.includes("INSERISCI")) {
    alert("Prima di attivare gli ordini, inserisci il numero WhatsApp nel file shop.js.");
    return;
  }

  let message = "Ciao! Vorrei richiedere informazioni su queste creazioni:\n\n";

  cart.forEach((item, index) => {
    message +=
      (index + 1) + ". " + item.product + "\n" +
      "Colore: " + item.color + "\n";

    if (item.name) {
      message += "Nome: " + item.name + "\n";
    }

    message += "\n";
  });

  message +=
    "Vorrei conoscere disponibilità, prezzo e modalità di spedizione. Grazie!";

  const url =
    "https://wa.me/" + whatsappNumber +
    "?text=" + encodeURIComponent(message);

  window.open(url, "_blank");
});

// Visualizza il carrello quando si apre la pagina
renderCart();