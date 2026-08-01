# Supervision des URL projets

Interface interne de suivi des URL **Front** et **Back-office** des projets gérés par les chefs de
projet. Chaque URL est testée à intervalle régulier ; le tableau de bord affiche l'état de chacune,
trié par gravité puis par priorité, avec un code couleur.

## Ce que l'outil détecte

| Cas | Détection |
|---|---|
| Site injoignable | DNS introuvable, connexion refusée, serveur injoignable |
| Erreur serveur | Code HTTP différent de celui attendu (500, 502, 403, 404…) |
| Erreur applicative masquée | Page qui répond **200** mais affiche « Erreur serveur » (fréquent sur les back-offices) |
| Lenteur | Temps de réponse au-delà d'un seuil configurable par URL |
| Blocage réseau | Dépassement du délai d'attente (timeout) |
| Panne annoncée | Certificat SSL expiré ou proche de l'expiration |

## Codes couleur

| Statut | Couleur | Signification |
|---|---|---|
| **En panne** | rouge | Échec confirmé (plusieurs tests consécutifs en erreur) |
| **Instable** | orange foncé | Échec en cours, pas encore confirmé |
| **Lent** | orange | Répond correctement mais au-delà du seuil de latence |
| **Opérationnel** | vert | Aucun problème détecté |
| **En pause** | gris | Surveillance désactivée pour cette URL |

Les priorités **P1 (critique)**, **P2 (important)** et **P3 (secondaire)** déterminent l'ordre
d'affichage à gravité égale, ainsi que la fréquence de test par défaut (3 / 5 / 15 minutes).

## Protection des serveurs surveillés

C'était la contrainte principale du cahier des charges. Les garde-fous en place :

- **Plancher de fréquence** : impossible de descendre sous 60 secondes entre deux tests (`MIN_INTERVAL_SECONDS`).
- **Une seule requête en vol par hôte** : deux URL du même serveur ne sont jamais testées simultanément.
- **Plafond global de requêtes simultanées** : 6 par défaut (`MAX_CONCURRENT_CHECKS`), quel que soit le nombre d'URL.
- **Désynchronisation (jitter)** : ±10 % sur chaque échéance, pour éviter les rafales toutes les 5 minutes pile.
- **Espacement automatique en cas de panne durable** : au-delà de 5 échecs consécutifs, l'intervalle
  double progressivement jusqu'à 15 minutes — on n'insiste pas sur un serveur déjà en difficulté.
- **Lecture de page plafonnée** : au maximum 256 Ko lus, et uniquement si une recherche de texte est
  configurée. Sinon le corps de la réponse n'est pas téléchargé du tout.
- **Méthode HEAD** disponible pour les URL où une simple vérification de disponibilité suffit.
- **User-Agent identifiable** (`LeniUrlMonitor/1.0`) : un hébergeur qui voit ce trafic dans ses logs
  comprend immédiatement de quoi il s'agit.
- **Bouton pause globale** pour interrompre tous les tests pendant une mise en production.

Ordre de grandeur : 300 URL testées toutes les 5 minutes représentent environ **1 requête par
seconde** répartie sur l'ensemble des serveurs — négligeable pour n'importe quel hébergement.

## Éviter les fausses alertes

Une URL ne passe **pas** en rouge au premier échec : il faut 3 tests consécutifs en erreur
(`FAILURE_THRESHOLD`). Entre-temps elle est affichée « Instable ». Cela évite qu'un incident réseau
d'une seconde ne déclenche une fausse panne.

## Démarrage

```bash
npm install
npm run dev            # développement, rechargement automatique
```

Puis ouvrir http://localhost:3000

En production :

```bash
npm run build
npm start
```

Jeu de données de démonstration (facultatif) : `npm run seed`

## Comment tester l'outil

Un faux serveur est fourni : il reproduit toutes les pannes que l'outil doit détecter, **sans
solliciter le moindre serveur client**.

Dans un premier terminal, lancer l'application :

```bash
npm install
npm run dev
```

Dans un second terminal, lancer le serveur de test :

```bash
npm run demo
```

Ouvrir http://localhost:3000, créer un projet (bouton « Nouveau projet »), puis ajouter les URL
ci-dessous avec « Ajouter une URL ». Le bouton **Tester** de chaque ligne force un test immédiat,
sans attendre la prochaine échéance.

| URL à saisir | Réglage particulier | Résultat attendu |
|---|---|---|
| `http://127.0.0.1:4599/ok` | Texte devant être présent : `Connexion` | 🟢 Opérationnel |
| `http://127.0.0.1:4599/lent` | Seuil « lent » : `500` ms | 🟠 Lent (~1500 ms) |
| `http://127.0.0.1:4599/erreur-500` | — | 🔴 En panne après 3 tests — `HTTP 500 (attendu 200)` |
| `http://127.0.0.1:4599/erreur-cachee` | Texte signalant une erreur : `Erreur serveur` | 🔴 En panne — page en 200 mais en erreur |
| `http://127.0.0.1:4599/gel` | Timeout : `3000` ms | 🔴 En panne — `Délai dépassé` |
| `http://127.0.0.1:9999/` | — | 🔴 En panne — `Connexion refusée par le serveur` |

Points à observer au passage :

- Les trois premiers tests d'une URL en erreur l'affichent en **Instable** (orange foncé) ; ce n'est
  qu'au troisième échec consécutif qu'elle passe en **En panne**. C'est le filtre anti-fausse-alerte.
- L'URL `/erreur-cachee` renvoie un code 200 : sans le champ « Texte signalant une erreur », elle
  apparaîtrait à tort en vert. C'est le réglage à ne pas oublier sur les back-offices.
- Le bouton **Détail** affiche l'historique, la latence et les incidents ouverts/résolus.
- Le bouton **Mettre en pause** arrête tous les tests, par exemple pendant une mise en production.

Pour repartir d'une base vierge, supprimer le dossier `data/`.

## Configuration

Toutes les variables sont facultatives ; les valeurs par défaut conviennent à un usage courant.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `DATABASE_FILE` | `data/monitor.db` | Emplacement de la base SQLite |
| `MAX_CONCURRENT_CHECKS` | `6` | Requêtes sortantes simultanées maximum |
| `MIN_INTERVAL_SECONDS` | `60` | Fréquence de test la plus agressive autorisée |
| `FAILURE_THRESHOLD` | `3` | Échecs consécutifs avant bascule en rouge |
| `BACKOFF_AFTER_FAILURES` | `5` | Échecs avant espacement automatique des tests |
| `RETENTION_DAYS` | `30` | Conservation du détail des tests |
| `USER_AGENT` | `LeniUrlMonitor/1.0` | Identité présentée aux serveurs surveillés |

## Données conservées

- **Détail de chaque test** pendant 30 jours (purge automatique quotidienne).
- **Agrégats journaliers** conservés sans limite : nombre de tests, échecs, latence moyenne et pic.
  Ils permettent de calculer un taux de disponibilité même après la purge du détail.
- **Incidents** : ouverture et résolution horodatées de chaque panne confirmée.

## API

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/dashboard` | État consolidé de toutes les URL |
| `GET/POST` | `/api/projects` | Liste et création de projets |
| `PUT/DELETE` | `/api/projects/:id` | Modification et suppression |
| `GET/POST` | `/api/endpoints` | Liste et création d'URL surveillées |
| `PUT/DELETE` | `/api/endpoints/:id` | Modification et suppression |
| `GET` | `/api/endpoints/:id/detail` | Historique, incidents et statistiques |
| `POST` | `/api/endpoints/:id/check` | Test immédiat |
| `POST` | `/api/settings/pause` | Pause / reprise globale |
| `GET` | `/api/health` | Sonde de disponibilité de l'outil lui-même |

Les mots de passe d'authentification basique ne sont jamais renvoyés par l'API.

## Limites connues

- **Pas d'authentification sur l'interface** : à déployer sur le réseau interne, ou derrière un
  reverse proxy assurant l'authentification. À traiter avant toute exposition publique.
- **Disponibilité ≠ bon fonctionnement** : l'outil vérifie qu'une page répond et ne contient pas de
  message d'erreur. Il ne teste pas les parcours métier (inscription, paiement…).
- **Back-offices protégés par IP** : l'adresse du serveur de supervision doit être autorisée côté
  hébergeur, sinon toutes les URL concernées remonteront en erreur.
- **Authentification par formulaire non gérée** : seule l'authentification HTTP basique est
  supportée. Pour un back-office avec formulaire de connexion, surveiller la page de login en
  vérifiant la présence d'un texte attendu.
- **Surveiller le superviseur** : si le service s'arrête, plus rien n'est testé. La route
  `/api/health` est prévue pour être interrogée par une supervision externe.
- **Alertes non incluses** : le tableau de bord doit être consulté. Les notifications e-mail/Teams
  sont prévues en phase suivante.

## Suite envisagée

1. Notifications e-mail / Teams à l'ouverture et à la résolution d'un incident, avec temporisation
   pour éviter le bruit.
2. Authentification de l'interface et gestion des droits par chef de projet.
3. Rapport de disponibilité mensuel exportable par projet.
4. Surveillance depuis plusieurs points géographiques pour distinguer panne réelle et problème réseau local.
