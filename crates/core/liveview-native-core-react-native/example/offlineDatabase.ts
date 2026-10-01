import { openDatabaseSync } from 'expo-sqlite';
import { measure } from '@liveview-native/react-native';
import { OfflineRepository, type SqlDriver } from './offlineRepository';
export function openOfflineRepository(origin: string) {
  const db = openDatabaseSync('lvn-checklist.db');
  const driver: SqlDriver = {
    exec: sql => db.execSync(sql),
    run: (sql, ...params) => { db.runSync(sql, ...params); },
    all: <T,>(sql: string, ...params: (string | number | null)[]) => db.getAllSync<T>(sql, ...params),
    first: <T,>(sql: string, ...params: (string | number | null)[]) => db.getFirstSync<T>(sql, ...params),
  };
  // Draft hydration occurs during a Form render. Export measurements after that stack finishes.
  return new OfflineRepository(driver, origin, (name, attributes) => { queueMicrotask(() => measure(name, attributes)); });
}
