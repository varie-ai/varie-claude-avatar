import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTracker } from './session-tracker';

interface DailyBucket {
  sessions: number;
  projects: Record<string, number>;
}

interface StatsData {
  daily: Record<string, DailyBucket>;
  lastCleanup: string;
}

export interface StatsSnapshot {
  active: number;
  today: number;
  week: number;
  topProjects: string[];
}

export class StatsTracker {
  private data: StatsData;
  private filePath: string;
  private sessionTracker: SessionTracker;

  constructor(sessionTracker: SessionTracker) {
    this.sessionTracker = sessionTracker;

    const configDir = path.join(os.homedir(), '.varie-claude-avatar');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    this.filePath = path.join(configDir, 'stats.json');
    this.data = this.load();
    this.cleanup();
  }

  private load(): StatsData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      // Ignore parse errors, start fresh
    }
    return { daily: {}, lastCleanup: new Date().toISOString() };
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  private localDateKey(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private todayKey(): string {
    return this.localDateKey(new Date());
  }

  private cleanup(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 8);
    const cutoffKey = this.localDateKey(cutoff);

    let changed = false;
    for (const key of Object.keys(this.data.daily)) {
      if (key < cutoffKey) {
        delete this.data.daily[key];
        changed = true;
      }
    }

    if (changed) {
      this.data.lastCleanup = new Date().toISOString();
      this.save();
    }
  }

  recordSession(project: string): void {
    const key = this.todayKey();
    if (!this.data.daily[key]) {
      this.data.daily[key] = { sessions: 0, projects: {} };
    }

    const bucket = this.data.daily[key];
    bucket.sessions++;

    if (project) {
      bucket.projects[project] = (bucket.projects[project] || 0) + 1;
    }

    this.save();
  }

  getStats(): StatsSnapshot {
    const active = this.sessionTracker.getActiveSessions().length;

    const todayKey = this.todayKey();
    const todayBucket = this.data.daily[todayKey];
    const today = todayBucket?.sessions || 0;

    // Sum last 7 days
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 6); // today + 6 prior days = 7 days
    const weekStartKey = this.localDateKey(weekStart);

    let week = 0;
    const projectTotals: Record<string, number> = {};

    for (const [key, bucket] of Object.entries(this.data.daily)) {
      if (key >= weekStartKey) {
        week += bucket.sessions;
        for (const [proj, count] of Object.entries(bucket.projects)) {
          projectTotals[proj] = (projectTotals[proj] || 0) + count;
        }
      }
    }

    // Top 2 projects by usage count
    const topProjects = Object.entries(projectTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([name]) => name);

    return { active, today, week, topProjects };
  }
}
