import { EventEmitter } from 'node:events';

export type ChangedEntity = 'media' | 'playlists' | 'schedules' | 'overrides' | 'groups' | 'screens';

interface Events {
  /** Изменились данные — админки перечитывают списки, планировщик пересчитывает экраны. */
  changed: [entity: ChangedEntity];
  /** Изменилась доступность хранилища или другая системная информация. */
  status: [];
}

/** Шина событий внутри процесса. */
export class AppEvents extends EventEmitter<Events> {
  changed(entity: ChangedEntity): void {
    this.emit('changed', entity);
  }
}
