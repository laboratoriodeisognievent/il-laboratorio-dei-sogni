const GITHUB_OWNER = "laboratoriodeisognievent";
const GITHUB_REPO = "il-laboratorio-dei-sogni";
const GITHUB_BRANCH = "main";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function base64url(value) {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return atob(padded);
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return base64url(
    String.fromCharCode(...new Uint8Array(signature))
  );
}

async function createSession(env) {
  const payload = {
    admin: true,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };

  const encoded = base64url(JSON.stringify(payload));
  const signature = await sign(encoded, env.SESSION_SECRET);

  return `${encoded}.${signature}`;
}

async function isAdmin(request, env) {
  try {
    if (!env.SESSION_SECRET) return false;

    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(/laboratorio_session=([^;]+)/);

    if (!match) return false;

    const parts = match[1].split(".");
    if (parts.length !== 2) return false;

    const [encoded, receivedSignature] = parts;
    const expectedSignature = await sign(encoded, env.SESSION_SECRET);

    if (receivedSignature !== expectedSignature) return false;

    const payload = JSON.parse(fromBase64url(encoded));

    return payload.admin === true && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function sessionCookie(value, maxAge = 604800) {
  return [
    `laboratorio_session=${value}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`
  ].join("; ");
}

function checkOrigin(request) {
  const origin = request.headers.get("Origin");

  if (!origin) return true;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function validImagePath(value) {
  if (!value) return true;

  if (typeof value !== "string" || value.length > 2000) {
    return false;
  }

  if (value.includes("..")) return false;

  if (/^\/images\/prodotti\/[a-zA-Z0-9._-]+$/.test(value)) {
    return true;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    if (
      url.hostname === "raw.githubusercontent.com" &&
      url.pathname.startsWith(
        `/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/images/prodotti/`
      ) &&
      !url.search &&
      !url.hash
    ) {
      return true;
    }

    // Compatibilità con eventuali vecchie foto Cloudinary.
    if (
      url.hostname === "res.cloudinary.com" &&
      url.pathname.startsWith("/ikvtqami/image/upload/")
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function parseFields(value) {
  if (Array.isArray(value)) return value;

  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split(":");

        if (parts.length > 1) {
          return {
            label: parts.shift().trim(),
            options: parts.join(":")
              .split(",")
              .map(item => item.trim())
              .filter(Boolean)
          };
        }

        return {
          label: line,
          options: []
        };
      });
  }
}

async function uploadImage(file, env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("Il secret GITHUB_TOKEN non è configurato su Cloudflare.");
  }

  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("Nessuna immagine ricevuta.");
  }

  if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
    throw new Error("L'immagine deve pesare al massimo 5 MB.");
  }

  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };

  const extension = extensions[file.type];

  if (!extension) {
    throw new Error("Formato non supportato. Usa JPG, PNG, WEBP o GIF.");
  }

  const filename = `${crypto.randomUUID()}.${extension}`;
  const path = `images/prodotti/${filename}`;

  const bytes = new Uint8Array(await file.arrayBuffer());

  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  const content = btoa(binary);

  const githubUrl =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

  const response = await fetch(githubUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Caricamento immagine prodotto ${filename}`,
      content,
      branch: GITHUB_BRANCH
    })
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.message || `Errore GitHub (${response.status}).`
    );
  }

  return {
    filename,
    image_url:
      `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`
  };
}

async function getCategories(env) {
  return env.DB.prepare(`
    SELECT *
    FROM categories
    WHERE active = 1
    ORDER BY sort_order ASC, id ASC
  `).all();
}

async function getProducts(env, url) {
  const category = url.searchParams.get("category");
  const subcategory = url.searchParams.get("subcategory");

  let sql = `
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.visible = 1
  `;

  const values = [];

  if (category) {
    sql += " AND c.slug = ?";
    values.push(category);
  }

  if (subcategory) {
    sql += " AND p.subcategory = ?";
    values.push(subcategory);
  }

  sql += " ORDER BY p.sort_order ASC, p.id DESC";

  return env.DB.prepare(sql).bind(...values).all();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ==========================
      // CONTROLLO DATABASE
      // ==========================

      if (path === "/api/health" && method === "GET") {
        await env.DB.prepare("SELECT 1").first();

        return json({
          success: true,
          message: "Worker pronto",
          database: "collegato",
          github: Boolean(env.GITHUB_TOKEN)
        });
      }

      // ==========================
      // LOGIN AMMINISTRATORE
      // ==========================

      if (path === "/api/admin/login" && method === "POST") {
        if (!checkOrigin(request)) {
          return json({ error: "Richiesta non autorizzata." }, 403);
        }

        if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
          return json({
            error: "Configurazione amministratore incompleta su Cloudflare."
          }, 500);
        }

        const body = await request.json();

        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");

        if (
          email !== String(env.ADMIN_EMAIL).trim().toLowerCase() ||
          password !== env.ADMIN_PASSWORD
        ) {
          return json({
            error: "Email o password non corretti."
          }, 401);
        }

        const session = await createSession(env);

        return new Response(
          JSON.stringify({ success: true }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "Set-Cookie": sessionCookie(session)
            }
          }
        );
      }

      // ==========================
      // LOGOUT
      // ==========================

      if (path === "/api/admin/logout" && method === "POST") {
        return new Response(
          JSON.stringify({ success: true }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": sessionCookie("", 0),
              "Cache-Control": "no-store"
            }
          }
        );
      }

      // ==========================
      // VERIFICA SESSIONE
      // ==========================

      if (path === "/api/admin/me" && method === "GET") {
        const authenticated = await isAdmin(request, env);

        return json({
          authenticated
        });
      }

      // ==========================
      // CATEGORIE PUBBLICHE
      // ==========================

      if (path === "/api/categories" && method === "GET") {
        const result = await getCategories(env);

        return json(result.results || []);
      }

      // ==========================
      // PRODOTTI PUBBLICI
      // ==========================

      if (path === "/api/products" && method === "GET") {
        const result = await getProducts(env, url);

        return json(result.results || []);
      }

      // ==========================
      // PROTEZIONE API ADMIN
      // ==========================

      if (path.startsWith("/api/admin/")) {
        if (!await isAdmin(request, env)) {
          return json({
            error: "Accesso non autorizzato. Effettua nuovamente il login."
          }, 401);
        }

        if (
          ["POST", "PUT", "DELETE", "PATCH"].includes(method) &&
          !checkOrigin(request)
        ) {
          return json({ error: "Richiesta non autorizzata." }, 403);
        }

        // ==========================
        // CARICAMENTO FOTO SU GITHUB
        // ==========================

        if (path === "/api/admin/upload-image" && method === "POST") {
          const formData = await request.formData();
          const file = formData.get("image");

          const uploaded = await uploadImage(file, env);

          return json({
            success: true,
            filename: uploaded.filename,
            image_url: uploaded.image_url
          });
        }

        // ==========================
        // ELENCO CATEGORIE ADMIN
        // ==========================

        if (path === "/api/admin/categories" && method === "GET") {
          const result = await env.DB.prepare(`
            SELECT *
            FROM categories
            ORDER BY sort_order ASC, id ASC
          `).all();

          return json(result.results || []);
        }

        // ==========================
        // ELENCO PRODOTTI ADMIN
        // ==========================

        if (path === "/api/admin/products" && method === "GET") {
          const result = await env.DB.prepare(`
            SELECT
              p.*,
              c.name AS category_name,
              c.slug AS category_slug
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            ORDER BY p.sort_order ASC, p.id DESC
          `).all();

          return json(result.results || []);
        }

        // ==========================
        // CREA PRODOTTO
        // ==========================

        if (path === "/api/admin/products" && method === "POST") {
          const body = await request.json();

          const name = String(body.name || "").trim();
          const categoryId = Number(body.category_id);
          const price = Number(body.price);

          if (!name) {
            return json({ error: "Inserisci il nome del prodotto." }, 400);
          }

          if (!Number.isInteger(categoryId) || categoryId <= 0) {
            return json({ error: "Seleziona una categoria valida." }, 400);
          }

          if (!Number.isFinite(price) || price < 0) {
            return json({ error: "Inserisci un prezzo valido." }, 400);
          }

          const imageUrl = body.image_url || "";

          if (!validImagePath(imageUrl)) {
            return json({ error: "Percorso immagine non valido." }, 400);
          }

          const customFields = JSON.stringify(
            parseFields(body.custom_fields)
          );

          const visible = body.visible === false || body.visible === 0
            ? 0
            : 1;

          const result = await env.DB.prepare(`
            INSERT INTO products (
              category_id,
              name,
              description,
              price,
              image_url,
              custom_fields,
              visible,
              sort_order,
              subcategory
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            categoryId,
            name,
            String(body.description || ""),
            price,
            imageUrl,
            customFields,
            visible,
            Number(body.sort_order || 0),
            String(body.subcategory || "")
          ).run();

          return json({
            success: true,
            id: result.meta.last_row_id
          }, 201);
        }

        // ==========================
        // MODIFICA PRODOTTO
        // ==========================

        const productMatch = path.match(
          /^\/api\/admin\/products\/(\d+)$/
        );

        if (productMatch && method === "PUT") {
          const id = Number(productMatch[1]);
          const body = await request.json();

          const name = String(body.name || "").trim();
          const categoryId = Number(body.category_id);
          const price = Number(body.price);

          if (!name) {
            return json({ error: "Inserisci il nome del prodotto." }, 400);
          }

          if (!Number.isInteger(categoryId) || categoryId <= 0) {
            return json({ error: "Seleziona una categoria valida." }, 400);
          }

          if (!Number.isFinite(price) || price < 0) {
            return json({ error: "Inserisci un prezzo valido." }, 400);
          }

          const imageUrl = body.image_url || "";

          if (!validImagePath(imageUrl)) {
            return json({ error: "Percorso immagine non valido." }, 400);
          }

          const customFields = JSON.stringify(
            parseFields(body.custom_fields)
          );

          const visible = body.visible === false || body.visible === 0
            ? 0
            : 1;

          const result = await env.DB.prepare(`
            UPDATE products
            SET
              category_id = ?,
              name = ?,
              description = ?,
              price = ?,
              image_url = ?,
              custom_fields = ?,
              visible = ?,
              sort_order = ?,
              subcategory = ?
            WHERE id = ?
          `).bind(
            categoryId,
            name,
            String(body.description || ""),
            price,
            imageUrl,
            customFields,
            visible,
            Number(body.sort_order || 0),
            String(body.subcategory || ""),
            id
          ).run();

          if (!result.meta.changes) {
            return json({ error: "Prodotto non trovato." }, 404);
          }

          return json({ success: true });
        }

        // ==========================
        // ELIMINA PRODOTTO
        // ==========================

        if (productMatch && method === "DELETE") {
          const id = Number(productMatch[1]);

          // Elimina prima eventuali immagini collegate.
          try {
            await env.DB.prepare(`
              DELETE FROM product_images
              WHERE product_id = ?
            `).bind(id).run();
          } catch (error) {
            // La cancellazione del prodotto continua anche
            // se la tabella delle immagini non è disponibile.
          }

          const result = await env.DB.prepare(`
            DELETE FROM products
            WHERE id = ?
          `).bind(id).run();

          if (!result.meta.changes) {
            return json({ error: "Prodotto non trovato." }, 404);
          }

          return json({ success: true });
        }

        return json({ error: "Endpoint amministratore non trovato." }, 404);
      }

      // ==========================
      // FILE STATICI DEL SITO
      // ==========================

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({ error: "Risorsa non trovata." }, 404);

    } catch (error) {
      return json({
        error: error.message || "Errore interno del server."
      }, 500);
    }
  }
};
