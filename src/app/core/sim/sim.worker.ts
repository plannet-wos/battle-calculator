/// <reference lib="webworker" />

/**
 * Sim worker — runs `recommendVsTargets` for one scenario per message.
 *
 * The calculator spawns a small pool of these workers (one per CPU core,
 * capped at the scenario count) and feeds them scenario IDs off a shared
 * queue. UI thread stays free while the heavy battle simulations run in
 * parallel across the pool.
 *
 * Message protocol — both directions:
 *   request:  { jobId, scenarioId, ownedHeroes, attBaseStats, attLevels, fast }
 *   response: { jobId, scenarioId, rec | null, error? }
 *
 * `jobId` lets the host correlate responses with requests if it ever sends
 * multiple requests to the same worker without awaiting between them.
 */

import { SimulatorService, SCENARIOS, VsTargetsRecommendation } from './simulator.service';
import type { ScenarioId } from './simulator.service';
import type { ScoredHero, AccountStats, TroopLevels } from '../models/hero.model';

interface SimRequest {
  jobId: number;
  scenarioId: ScenarioId;
  ownedHeroes: ScoredHero[];
  attBaseStats: AccountStats;
  attLevels: TroopLevels;
  fast: boolean;
}

interface SimResponse {
  jobId: number;
  scenarioId: ScenarioId;
  rec: VsTargetsRecommendation | null;
  error?: string;
}

const sim = new SimulatorService();

addEventListener('message', (event: MessageEvent<SimRequest>) => {
  const req = event.data;
  try {
    const rec = sim.recommendVsTargets(
      req.ownedHeroes,
      req.attBaseStats,
      req.attLevels,
      SCENARIOS[req.scenarioId],
      { fast: req.fast },
    );
    const resp: SimResponse = { jobId: req.jobId, scenarioId: req.scenarioId, rec };
    postMessage(resp);
  } catch (err) {
    const resp: SimResponse = {
      jobId: req.jobId,
      scenarioId: req.scenarioId,
      rec: null,
      error: (err as Error).message ?? String(err),
    };
    postMessage(resp);
  }
});
