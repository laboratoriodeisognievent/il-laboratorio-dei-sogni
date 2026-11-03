export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Controllo del collegamento al database
    if (url.pathname === "/api/health") {
      try {
        await env.DB.prepare("SELECT 1").first();

        return Response.json({
          success: true,
          database: "collegato"
        });

      } catch (error) {
        return Response.json({
          success: false,
          message: "Errore nel collegamento al database"
        }, { status: 500 });
      }
    }

    // Visualizzazione delle pagine del sito
    return env.ASSETS.fetch(request);
  }
};
