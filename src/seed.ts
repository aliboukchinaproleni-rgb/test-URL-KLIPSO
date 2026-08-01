import { db } from './db.js';
import { ensureStateRows } from './scheduler.js';

const projects = [
  {
    name: 'Salon Klipso Démo',
    client: 'COMEXPOSIUM',
    owner: 'CDP 1',
    endpoints: [
      { kind: 'front', label: 'Site inscription visiteurs', url: 'https://example.com/', priority: 'P1' },
      { kind: 'back', label: 'Back-office Klipso', url: 'https://example.org/', priority: 'P1' },
    ],
  },
  {
    name: 'Projet test interne',
    client: 'Leni',
    owner: 'CDP 2',
    endpoints: [
      { kind: 'front', label: 'Page publique', url: 'https://httpbin.org/status/200', priority: 'P2' },
      { kind: 'back', label: 'URL volontairement en erreur', url: 'https://httpbin.org/status/500', priority: 'P3' },
    ],
  },
];

const insertProject = db.prepare('INSERT INTO projects (name, client, owner) VALUES (?, ?, ?)');
const insertEndpoint = db.prepare(
  `INSERT INTO endpoints (project_id, kind, label, url, priority, interval_seconds)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

db.transaction(() => {
  for (const project of projects) {
    const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(project.name) as
      | { id: number }
      | undefined;
    if (existing) continue;
    const info = insertProject.run(project.name, project.client, project.owner);
    for (const endpoint of project.endpoints) {
      insertEndpoint.run(
        info.lastInsertRowid,
        endpoint.kind,
        endpoint.label,
        endpoint.url,
        endpoint.priority,
        endpoint.priority === 'P1' ? 180 : 300,
      );
    }
  }
})();

ensureStateRows();
console.log('Jeu de démonstration créé.');
