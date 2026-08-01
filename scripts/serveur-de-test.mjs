/**
 * Faux serveur de recette : reproduit les pannes que l'outil doit détecter,
 * sans solliciter le moindre serveur client.
 *
 *   node scripts/serveur-de-test.mjs      (ou : npm run demo)
 */
import http from 'node:http';

const PORT = Number(process.env.DEMO_PORT ?? 4599);

const ROUTES = {
  '/ok': (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Espace client</h1><p>Connexion</p></body></html>');
  },
  '/lent': async (res) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>Page lente mais fonctionnelle</body></html>');
  },
  '/erreur-500': (res) => {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>Internal Server Error</body></html>');
  },
  '/erreur-cachee': (res) => {
    // Le piège classique des back-offices : statut 200, mais page en erreur.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Erreur serveur</h1><p>Base de données injoignable.</p></body></html>');
  },
  '/gel': () => {
    // Ne répond jamais : permet de vérifier le timeout.
  },
};

http
  .createServer((req, res) => {
    const path = new URL(req.url, `http://localhost:${PORT}`).pathname;
    const handler = ROUTES[path];
    if (handler) return void handler(res);
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>Page introuvable</body></html>');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Serveur de test démarré sur http://127.0.0.1:${PORT}`);
    console.log('\nURL à saisir dans l’interface de supervision :\n');
    console.log(`  http://127.0.0.1:${PORT}/ok             → doit rester VERT`);
    console.log(`  http://127.0.0.1:${PORT}/lent           → ORANGE « Lent » si seuil réglé à 500 ms`);
    console.log(`  http://127.0.0.1:${PORT}/erreur-500     → ROUGE après 3 tests`);
    console.log(`  http://127.0.0.1:${PORT}/erreur-cachee  → ROUGE avec « Texte signalant une erreur » = Erreur serveur`);
    console.log(`  http://127.0.0.1:${PORT}/gel            → ROUGE par dépassement du délai d’attente`);
    console.log(`  http://127.0.0.1:9999/                  → ROUGE « Connexion refusée » (aucun serveur ici)`);
    console.log('\nCtrl+C pour arrêter.');
  });
