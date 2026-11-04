function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

function base64url(value) {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

async function createSession(email, secret) {
  const payload = base64url(JSON.stringify({
    email,
    exp: Date.now() + 12 * 60 * 60 * 1000
  }));

  return payload + "." + await sign(payload, secret);
}

async function isAdmin(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);

  if (!match || !env.SESSION_SECRET) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const expected = await sign(parts[0], env.SESSION_SECRET);
  if (expected !== parts[1]) return false;

  try {
    const payload = JSON.parse(
      atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))
    );

    return payload.email === env.ADMIN_EMAIL &&
      payload.exp > Date.now();

  } catch {
    return false;
  }
}

function checkOrigin(request, url) {
  return request.headers.get("Origin") === url.origin;
}

function validImagePath(value) {
  return typeof value === "string" &&
    value.startsWith("/images/prodotti/") &&
    !value.includes("..");
}

function parseFields(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path.startsWith("/api/")) {

        /* VERIFICA DATABASE */

        if (path === "/api/health" && method === "GET") {
          await env.DB.prepare("SELECT 1").first();

          return json({
            success: true,
            database: "collegato"
          });
        }

        /* LOGIN */

        if (path === "/api/admin/login" && method === "POST") {
          if (!checkOrigin(request, url)) {
            return json({ error: "Richiesta non autorizzata" }, 403);
          }

          const body = await request.json();

          if (
            body.email !== env.ADMIN_EMAIL ||
            body.password !== env.ADMIN_PASSWORD
          ) {
            return json({
              error: "Email o password non corrette"
            }, 401);
          }

          const token = await createSession(
            env.ADMIN_EMAIL,
            env.SESSION_SECRET
          );

          return json(
            { success: true },
            200,
            {
              "Set-Cookie":
                `admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`
            }
          );
        }

        /* LOGOUT */

        if (path === "/api/admin/logout" && method === "POST") {
          if (!checkOrigin(request, url)) {
            return json({ error: "Richiesta non autorizzata" }, 403);
          }

          return json(
            { success: true },
            200,
            {
              "Set-Cookie":
                "admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
            }
          );
        }

        /* VERIFICA ACCESSO */

        if (path === "/api/admin/me" && method === "GET") {
          if (!await isAdmin(request, env)) {
            return json({ authenticated: false }, 401);
          }

          return json({ authenticated: true });
        }

        /* CATEGORIE PUBBLICHE */

        if (path === "/api/categories" && method === "GET") {
          const result = await env.DB.prepare(`
            SELECT id, name, slug, description, sort_order
            FROM categories
            WHERE active = 1
            ORDER BY sort_order
          `).all();

          return json(result.results);
        }

        /* PRODOTTI PUBBLICI */

        if (path === "/api/products" && method === "GET") {
          const category = url.searchParams.get("category");
          const subcategory = url.searchParams.get("subcategory");

          let query = `
            SELECT
              p.*,
              c.name AS category_name,
              c.slug AS category_slug
            FROM products p
            JOIN categories c ON c.id = p.category_id
            WHERE p.visible = 1 AND c.active = 1
          `;

          const params = [];

          if (category) {
            query += " AND c.slug = ?";
            params.push(category);
          }

          if (subcategory && category === "catenelle-ciuccio") {
            query += " AND p.subcategory = ?";
            params.push(subcategory);
          }

          query += " ORDER BY p.sort_order, p.id DESC";

          const statement = env.DB.prepare(query).bind(...params);
          const result = await statement.all();

          return json(result.results.map(product => ({
            ...product,
            custom_fields: parseFields(product.custom_fields)
          })));
        }

        /* DA QUI SERVE L'ACCESSO AMMINISTRATORE */

        if (path.startsWith("/api/admin/")) {
          if (!await isAdmin(request, env)) {
            return json({
              error: "Accesso non autorizzato"
            }, 401);
          }

          if (method !== "GET" && !checkOrigin(request, url)) {
            return json({
              error: "Richiesta non autorizzata"
            }, 403);
          }

          /* ELENCO PRODOTTI */

          if (path === "/api/admin/products" && method === "GET") {
            const result = await env.DB.prepare(`
              SELECT * FROM products
              ORDER BY sort_order, id DESC
            `).all();

            return json(result.results.map(product => ({
              ...product,
              custom_fields: parseFields(product.custom_fields)
            })));
          }

          /* ELENCO CATEGORIE */

          if (path === "/api/admin/categories" && method === "GET") {
            const result = await env.DB.prepare(`
              SELECT * FROM categories
              ORDER BY sort_order
            `).all();

            return json(result.results);
          }

          /* AGGIUNTA PRODOTTO */

          if (path === "/api/admin/products" && method === "POST") {
            const body = await request.json();

            if (
              !body.name ||
              !Number.isInteger(Number(body.category_id))
            ) {
              return json({
                error: "Inserisci nome e categoria"
              }, 400);
            }

            if (body.image_url && !validImagePath(body.image_url)) {
              return json({
                error: "Percorso immagine non valido"
              }, 400);
            }

            const result = await env.DB.prepare(`
              INSERT INTO products
              (
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
              Number(body.category_id),
              body.name.trim(),
              body.description || "",
              Number(body.price) || 0,
              body.image_url || "",
              JSON.stringify(body.custom_fields || []),
              body.visible === false ? 0 : 1,
              Number(body.sort_order) || 0,
              body.subcategory === "maschietto"
                ? "maschietto"
                : "femminuccia"
            ).run();

            return json({
              success: true,
              id: result.meta.last_row_id
            }, 201);
          }

          /* MODIFICA O ELIMINAZIONE PRODOTTO */

          const match = path.match(
            /^\/api\/admin\/products\/(\d+)$/
          );

          if (match) {
            const id = Number(match[1]);

            /* MODIFICA */

            if (method === "PUT") {
              const body = await request.json();

              if (
                !body.name ||
                !Number.isInteger(Number(body.category_id))
              ) {
                return json({
                  error: "Inserisci nome e categoria"
                }, 400);
              }

              if (body.image_url && !validImagePath(body.image_url)) {
                return json({
                  error: "Percorso immagine non valido"
                }, 400);
              }

              await env.DB.prepare(`
                UPDATE products SET
                  category_id = ?,
                  name = ?,
                  description = ?,
                  price = ?,
                  image_url = ?,
                  custom_fields = ?,
                  visible = ?,
                  sort_order = ?,
                  subcategory = ?,
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).bind(
                Number(body.category_id),
                body.name.trim(),
                body.description || "",
                Number(body.price) || 0,
                body.image_url || "",
                JSON.stringify(body.custom_fields || []),
                body.visible === false ? 0 : 1,
                Number(body.sort_order) || 0,
                body.subcategory === "maschietto"
                  ? "maschietto"
                  : "femminuccia",
                id
              ).run();

              return json({ success: true });
            }

            /* ELIMINAZIONE */

            if (method === "DELETE") {
              await env.DB.prepare(
                "DELETE FROM product_images WHERE product_id = ?"
              ).bind(id).run();

              await env.DB.prepare(
                "DELETE FROM products WHERE id = ?"
              ).bind(id).run();

              return json({ success: true });
            }
          }

          return json({
            error: "Operazione non disponibile"
          }, 404);
        }

        return json({
          error: "Endpoint non trovato"
        }, 404);
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      return json({
        error: "Errore interno del server"
      }, 500);
    }
  }
};
