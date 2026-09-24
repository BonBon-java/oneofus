'use strict';

class DrawSnapshotService {
  constructor(repository) { this.repository = repository; }
  async createDrawSnapshot(roundId) { return this.repository.createDrawSnapshot(roundId); }
}

module.exports = { DrawSnapshotService };
