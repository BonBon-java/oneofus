'use strict';

class RoundClosingService {
  constructor(repository) { this.repository = repository; }
  async closeRound(roundId) { return this.repository.closeRound(roundId); }
}

module.exports = { RoundClosingService };
