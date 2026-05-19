import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '..', 'config.json');

export type GeoLocation = 'latam' | 'usa' | 'europe' | 'worldwide';
export type ContractType = 'full-time' | 'part-time' | 'contract' | 'freelance' | 'temporary';
export type ExperienceLevel = 'junior' | 'mid' | 'senior' | 'lead' | 'staff' | 'principal' | 'director' | 'c-level';

export interface ScrapingConfig {
  maxPages: number;
  maxJobs: number;
  maxAgeDays: number;
}

export interface SalaryConfig {
  hour: number | null;
  month: number | null;
  annual: number | null;
}

export interface PrioritySalaryConfig {
  hourMin: number;
  annualMin: number;
}

export interface FiltersConfig {
  geoLocations: GeoLocation[];
  skills: string[];
  jobTitle: string[];
  excludedCompanies: string[];
  excludeSkills: string[];
  excludeUsOnly: boolean;
  excludeIndia: boolean;
  excludeUae: boolean;
  excludeSoutheastAsia: boolean;
  experience: ExperienceLevel[];
  excludeClearance: boolean;
  excludeOnSite: boolean;
  excludeHybrid: boolean;
  excludeEquityOnly: boolean;
  excludeCrypto: boolean;
  remote: boolean;
  salary: SalaryConfig;
  prioritySalary: PrioritySalaryConfig;
  contractTypes: ContractType[];
  language: string[];
}

export interface AppConfig {
  scraping: ScrapingConfig;
  filters: FiltersConfig;
}

export function loadConfig(): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to load config.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const config = raw as AppConfig;

  if (!config.filters?.jobTitle || config.filters.jobTitle.length === 0) {
    throw new Error('config.json: filters.jobTitle must have at least one entry');
  }

  if (!config.filters?.skills || config.filters.skills.length === 0) {
    throw new Error('config.json: filters.skills must have at least one entry');
  }

  return config;
}
