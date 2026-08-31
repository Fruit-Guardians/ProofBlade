import { canonicalJson, sha256 } from "../domain/utils.js";

export type InformationEstimatorKind = "heuristic" | "pmi" | "posterior_eig" | "decision_voi" | "verified_uplift";

export interface InformationValueEstimate {
  schemaVersion: 1;
  estimatorKind: InformationEstimatorKind;
  estimatorVersion: string;
  score: number;
  components: Record<string, number>;
  inputHashes: { hypothesis?: string; evidenceGap?: string; candidate?: string; budget?: string; outcomes?: string };
  calibrated: boolean;
  confidenceInterval?: { low: number; high: number };
  online: boolean;
}

export interface HeuristicInformationInput { novelty: number; evidenceGap: number; expectedConfidence: number; cost: number; }
export function estimateHeuristicInformation(input: HeuristicInformationInput): InformationValueEstimate {
  const components = { novelty: unit(input.novelty, "novelty"), evidenceGap: unit(input.evidenceGap, "evidenceGap"), expectedConfidence: unit(input.expectedConfidence, "expectedConfidence"), cost: unit(input.cost, "cost") };
  const score = clamp(components.novelty * 0.3 + components.evidenceGap * 0.3 + components.expectedConfidence * 0.2 - components.cost * 0.2);
  return estimate("heuristic", score, components, { candidate: input, budget: { cost: components.cost } }, false, true, undefined, { candidate: input, budget: { cost: components.cost } });
}

export interface PmiInput { queryCount: number; contextCount: number; jointCount: number; totalCount: number; }
export function estimatePmi(input: PmiInput): InformationValueEstimate {
  for (const [key, value] of Object.entries(input)) if (!Number.isFinite(value) || value <= 0) throw new Error(`PMI ${key} must be positive`);
  if (input.jointCount > input.queryCount || input.jointCount > input.contextCount || input.queryCount > input.totalCount || input.contextCount > input.totalCount) throw new Error("PMI counts are inconsistent");
  const pmi = Math.log2((input.jointCount * input.totalCount) / (input.queryCount * input.contextCount));
  return estimate("pmi", pmi, { pmi, queryProbability: input.queryCount / input.totalCount, contextProbability: input.contextCount / input.totalCount, jointProbability: input.jointCount / input.totalCount }, input, false, true, undefined, { candidate: input });
}

export interface PosteriorHypothesis { id: string; prior: number; likelihoodByOutcome: Record<string, number>; }
export function estimatePosteriorEIG(hypotheses: readonly PosteriorHypothesis[]): InformationValueEstimate {
  if (hypotheses.length < 2) throw new Error("posterior EIG requires at least two hypotheses");
  const priorTotal = hypotheses.reduce((sum, item) => sum + item.prior, 0);
  if (Math.abs(priorTotal - 1) > 1e-6) throw new Error("posterior EIG priors must sum to 1");
  const outcomes = [...new Set(hypotheses.flatMap((item) => Object.keys(item.likelihoodByOutcome)))].sort();
  if (outcomes.length < 2) throw new Error("posterior EIG requires at least two possible outcomes");
  for (const hypothesis of hypotheses) {
    if (!Number.isFinite(hypothesis.prior) || hypothesis.prior <= 0) throw new Error("posterior EIG priors must be positive");
    const likelihoodTotal = outcomes.reduce((sum, outcome) => sum + (hypothesis.likelihoodByOutcome[outcome] ?? 0), 0);
    if (Math.abs(likelihoodTotal - 1) > 1e-6) throw new Error(`posterior EIG likelihoods for ${hypothesis.id} must sum to 1`);
    for (const probability of Object.values(hypothesis.likelihoodByOutcome)) if (!Number.isFinite(probability) || probability < 0) throw new Error("posterior EIG likelihoods must be non-negative");
  }
  const priorEntropy = entropy(hypotheses.map((item) => item.prior));
  const outcomeProbability = outcomes.map((outcome) => hypotheses.reduce((sum, item) => sum + item.prior * (item.likelihoodByOutcome[outcome] ?? 0), 0));
  const posteriorEntropy = outcomes.reduce((sum, _outcome, index) => {
    const probability = outcomeProbability[index]!;
    if (probability === 0) return sum;
    const posterior = hypotheses.map((item) => item.prior * (item.likelihoodByOutcome[outcomes[index]!] ?? 0) / probability);
    return sum + probability * entropy(posterior);
  }, 0);
  const eig = Math.max(0, priorEntropy - posteriorEntropy);
  return estimate("posterior_eig", eig, { priorEntropy, expectedPosteriorEntropy: posteriorEntropy, outcomeEntropy: entropy(outcomeProbability) }, { hypotheses, outcomes }, true, true, undefined, { hypothesis: hypotheses, outcomes });
}

export interface DecisionVoiInput { currentUtility: number; outcomeUtilities: readonly number[]; outcomeProbabilities: readonly number[]; cost: number; }
export function estimateDecisionVoi(input: DecisionVoiInput): InformationValueEstimate {
  if (input.outcomeUtilities.length === 0 || input.outcomeUtilities.length !== input.outcomeProbabilities.length) throw new Error("decision VOI outcomes and probabilities must have equal non-zero length");
  for (const probability of input.outcomeProbabilities) if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("decision VOI probabilities must be finite values between 0 and 1");
  for (const utility of input.outcomeUtilities) if (!Number.isFinite(utility)) throw new Error("decision VOI utilities must be finite");
  const total = input.outcomeProbabilities.reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error("decision VOI probabilities must sum to 1");
  if (!Number.isFinite(input.currentUtility) || !Number.isFinite(input.cost) || input.cost < 0) throw new Error("decision VOI utility and cost must be finite");
  const expectedUtility = input.outcomeUtilities.reduce((sum, utility, index) => sum + utility * input.outcomeProbabilities[index]!, 0);
  const netVoi = expectedUtility - input.currentUtility - input.cost;
  return estimate("decision_voi", netVoi, { expectedUtility, currentUtility: input.currentUtility, cost: input.cost, grossValue: expectedUtility - input.currentUtility }, input, true, true, undefined, { candidate: input, budget: { cost: input.cost } });
}

export interface VerifiedUpliftInput { baselineSuccessRate: number; candidateSuccessRate: number; baselineEvidenceCoverage: number; candidateEvidenceCoverage: number; sampleSize: number; }
export function estimateVerifiedUplift(input: VerifiedUpliftInput): InformationValueEstimate {
  for (const [key, value] of Object.entries(input)) if (!Number.isFinite(value) || (key !== "sampleSize" && (value < 0 || value > 1)) || (key === "sampleSize" && value < 1)) throw new Error(`verified uplift ${key} is invalid`);
  const successUplift = input.candidateSuccessRate - input.baselineSuccessRate;
  const evidenceUplift = input.candidateEvidenceCoverage - input.baselineEvidenceCoverage;
  const standardError = Math.sqrt(Math.max(1e-12, (input.baselineSuccessRate * (1 - input.baselineSuccessRate) + input.candidateSuccessRate * (1 - input.candidateSuccessRate)) / input.sampleSize));
  return estimate("verified_uplift", successUplift, { successUplift, evidenceUplift, standardError }, input, false, false, { low: successUplift - 1.96 * standardError, high: successUplift + 1.96 * standardError }, { outcomes: input });
}

function estimate(kind: InformationEstimatorKind, score: number, components: Record<string, number>, input: unknown, calibrated: boolean, online: boolean, confidenceInterval?: { low: number; high: number }, parts?: Partial<Record<keyof InformationValueEstimate["inputHashes"], unknown>>): InformationValueEstimate {
  const hashes = canonicalHashes(input, parts);
  return { schemaVersion: 1, estimatorKind: kind, estimatorVersion: `${kind}-v1`, score, components, inputHashes: hashes, calibrated, ...(confidenceInterval ? { confidenceInterval } : {}), online };
}
function canonicalHashes(input: unknown, parts?: Partial<Record<keyof InformationValueEstimate["inputHashes"], unknown>>): InformationValueEstimate["inputHashes"] {
  const fallback = sha256(canonicalJson(input));
  const output: InformationValueEstimate["inputHashes"] = {};
  for (const key of ["hypothesis", "evidenceGap", "candidate", "budget", "outcomes"] as const) if (parts?.[key] !== undefined) output[key] = sha256(canonicalJson(parts[key]));
  if (Object.keys(output).length === 0) output.candidate = fallback;
  return output;
}
function entropy(probabilities: readonly number[]): number { return probabilities.reduce((sum, p) => p > 0 ? sum - p * Math.log2(p) : sum, 0); }
function unit(value: number, label: string): number { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`); return value; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
