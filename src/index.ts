#!/usr/bin/env node

import { access, glob, readdir, readFile, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Every session has a start, an end, and a list of projects changed in that time
 */
type Session = {
  kind: "Session";
  start: number;
  end: number | null;
  projectsChanged: string[];
};

const HOME = homedir();
const CONFIG_PATH = resolve(HOME, ".config/amser.json");
const DEFAULT_SESSION_PATH = resolve(HOME, "amser.json");
const DEFAULT_DEV_PATH = resolve(HOME, "dev");

type Config = {
  pathToDevFolder: string;
  pathToStoreSessions: string;
};

const TIME_RANGE = ["day", "week", "month", "year"] as const;
type TimeRange = (typeof TIME_RANGE)[number];

function isTimeRange(range: string): range is TimeRange {
  return TIME_RANGE.includes(range as TimeRange);
}

const timeAgo: Record<TimeRange, number> = {
  day: 1000 * 60 * 60 * 24,
  week: 1000 * 60 * 60 * 24 * 7,
  month: 1000 * 60 * 60 * 24 * 30,
  year: 1000 * 60 * 60 * 24 * 365,
};

async function storeSessions(
  config: Config,
  sessions: Session[]
): Promise<void> {
  await writeFile(config.pathToStoreSessions, JSON.stringify(sessions));
}

async function getSessions(config: Config): Promise<Session[]> {
  let rawData = null;
  try {
    rawData = await readFile(config.pathToStoreSessions, "utf8");
  } catch (e) {
    return [];
  }

  return JSON.parse(rawData);
}

async function saveSession(config: Config, session: Session): Promise<void> {
  const sessions = await getSessions(config);

  const currentSession = await getCurrentSession(config);

  if (!currentSession) {
    sessions.push(session);
  } else {
    if (currentSession.start === session.start) {
      sessions[sessions.length - 1] = session;
    } else {
      sessions.push(session);
    }
  }

  await storeSessions(config, sessions);
}

async function getCurrentSession(config: Config): Promise<Session | null> {
  const sessions = await getSessions(config);

  if (
    sessions[sessions.length - 1] &&
    sessions[sessions.length - 1].end === null
  ) {
    return sessions[sessions.length - 1];
  }
  return null;
}

/**
 * Start a new session if one doesn't exist
 */
async function checkIn(config: Config): Promise<void> {
  const start = Date.now();

  const maybeCurrentSession = await getCurrentSession(config);

  if (maybeCurrentSession && maybeCurrentSession.end === null) {
    console.error("There's already a current session, end that one first.");
    return;
  }

  const startedSession: Session = {
    kind: "Session",
    start,
    end: null,
    projectsChanged: [],
  };

  await saveSession(config, startedSession);
}

async function hasGitDir(path: string): Promise<boolean> {
  const resolved = resolve(path, "./.git");
  try {
    await access(resolved);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Look at common developer folders for changes
 */
async function hasChangedFiles(
  baseDir: string,
  sessionStartTime: number
): Promise<boolean> {
  for await (const fileOrFolder of glob(
    [
      `${baseDir}/src/**`,
      `${baseDir}/tests/**`,
      `${baseDir}/.git/*`,
      `${baseDir}/*.md`,
    ],
    {
      exclude: [".git", "node_modules"],
      withFileTypes: true,
    }
  )) {
    const resolved = join(fileOrFolder.parentPath, fileOrFolder.name);
    const stats = await stat(resolved);

    const hasBeenModifiedSinceStartOfSession = sessionStartTime < stats.mtimeMs;
    const hasBeenCreatedSinceStartOfSession = sessionStartTime < stats.ctimeMs;
    if (
      hasBeenModifiedSinceStartOfSession ||
      hasBeenCreatedSinceStartOfSession
    ) {
      return true;
    }
  }

  return false;
}

type CheckedPath = {
  resolvedPath: string;
  hasChangedFilesOrFolders: boolean;
};

/**
 * @param baseDir the dir to start looking in
 * @param sessionStartTime when the session started
 * @returns Return a list of projects which have been modified since the session started
 */
async function projectsModifiedSince(
  baseDir: string,
  sessionStartTime: number
): Promise<string[]> {
  const topLevelFolders = await readdir(baseDir, {
    withFileTypes: true,
  });

  const topLevelFoldersWithGit: string[] = [];
  const checkSubFoldersPromises: Promise<string[]>[] = [];
  const changedSinceTime: string[] = [];

  for (const dir of topLevelFolders) {
    if (dir.isDirectory()) {
      const resolved = join(dir.parentPath, dir.name);
      if (await hasGitDir(resolved)) {
        topLevelFoldersWithGit.push(resolved);
      } else {
        checkSubFoldersPromises.push(
          projectsModifiedSince(resolved, sessionStartTime)
        );
      }
    }
  }

  const changedSubDirs: CheckedPath[] = (
    await Promise.all(checkSubFoldersPromises)
  )
    .flat()
    .map((resolvedPath: string): CheckedPath => {
      return { resolvedPath, hasChangedFilesOrFolders: true };
    });

  const changedDirs: CheckedPath[] = await Promise.all(
    topLevelFoldersWithGit.map(async (resolvedPath) => {
      return {
        resolvedPath,
        hasChangedFilesOrFolders: await hasChangedFiles(
          resolvedPath,
          sessionStartTime
        ),
      };
    })
  );

  const allChangedFolders: CheckedPath[] = [...changedDirs, ...changedSubDirs];

  for (const { resolvedPath, hasChangedFilesOrFolders } of allChangedFolders) {
    if (hasChangedFilesOrFolders) {
      changedSinceTime.push(resolvedPath);
    }
  }

  return changedSinceTime;
}

/**
 * End a session
 * @param config global config for amser
 * @returns returns the session if one existed
 */
async function checkOut(config: Config): Promise<Session | null> {
  const endTime = Date.now();
  const maybeCurrentSession = await getCurrentSession(config);

  if (!maybeCurrentSession || maybeCurrentSession.end !== null) {
    console.error("No session found. Create a session before checking out");
    return null;
  }

  const projects = await projectsModifiedSince(
    config.pathToDevFolder,
    maybeCurrentSession.start
  );

  maybeCurrentSession.projectsChanged = projects;
  maybeCurrentSession.end = endTime;

  saveSession(config, maybeCurrentSession);

  return maybeCurrentSession;
}

/**
 * Create the default config. If it already exists, inform the user where it lives.
 */
async function initConfig() {
  const defaultConfig: Config = {
    pathToDevFolder: DEFAULT_DEV_PATH,
    pathToStoreSessions: DEFAULT_SESSION_PATH,
  };

  try {
    await readFile(CONFIG_PATH);
    console.log("Config already exists, it lives at", CONFIG_PATH);
  } catch (e) {
    await writeFile(CONFIG_PATH, JSON.stringify(defaultConfig, null, 4) + "\n");
    console.log("Created config at", CONFIG_PATH);
    console.log("Default config:", defaultConfig);
  }

  return defaultConfig;
}

function convertMillisecondsIntoHumanReadable(milliseconds: number): string {
  const hours = milliseconds / (1000 * 60 * 60);
  const absoluteHours = Math.floor(hours);
  const h = absoluteHours > 9 ? absoluteHours : "0" + absoluteHours;

  const minutes = (hours - absoluteHours) * 60;
  const absoluteMinutes = Math.floor(minutes);
  const m = absoluteMinutes > 9 ? absoluteMinutes : "0" + absoluteMinutes;

  const seconds = (minutes - absoluteMinutes) * 60;
  const absoluteSeconds = Math.floor(seconds);
  const s = absoluteSeconds > 9 ? absoluteSeconds : "0" + absoluteSeconds;

  return `${h}:${m}:${s}`;
}

/**
 * Hacky way to get the first non-title line in a README.md
 */
async function getDescriptionFromReadme(pathToReadme: string): Promise<string> {
  try {
    const readmeText = await readFile(pathToReadme, "utf8");

    return readmeText
      .split("#")[1]
      .split("\n")
      .slice(1, -1)
      .join("\n")
      .split(". ")[0]
      .trim()
      .split("\n")[0]
      .trim();
  } catch (e) {
    return pathToReadme.split("/").pop() || "";
  }
}

/**
 * Display the sessions within the given time range
 * @param timeRange day, week, month, or year
 */
async function display(config: Config, timeRange: TimeRange): Promise<void> {
  const now = Date.now();
  const cutoffStartTime = now - timeAgo[timeRange];
  const sessions = (await getSessions(config)).filter(
    (session) => session.start > cutoffStartTime
  );

  const proccessedProjects: string[] = [];
  const descriptions: { project: string; description: string }[] = [];

  for (const session of sessions) {
    const timeSpent =
      session.end === null
        ? Date.now() - session.start
        : session.end - session.start;

    for (const project of session.projectsChanged) {
      if (project.trim().length === 0 || proccessedProjects.includes(project)) {
        continue;
      }

      const pathToReadme = resolve(project, "README.md");
      const description = await getDescriptionFromReadme(pathToReadme);

      descriptions.push({ project, description });
      proccessedProjects.push(project);
    }

    const humanReadableTime = convertMillisecondsIntoHumanReadable(timeSpent);
    console.table({
      ...session,
      projectsChanged: session.projectsChanged.join(", "),
      start: new Date(session.start).toLocaleString(),
      end: session.end ? new Date(session.end).toLocaleString() : null,
      humanReadableTime,
    });
  }
  console.table(descriptions);
}

function helpMessage() {
  const commands: Record<string, string> = {
    in: "Start a session",
    out: "End a session",
    config: "Create the first config",
    display:
      "Display sessions within a given time period. day, week, month, year. Defaults to week",
  };

  console.log("Usage: @eeue56/amser [command]");
  console.log("Available commands: ", Object.keys(commands));
  for (const command of Object.keys(commands)) {
    const helpMessage = commands[command];
    console.log(`${command}:`, helpMessage);
  }

  console.log(
    "\nA simple way to keep track of time when working on different projects."
  );
}

async function main(): Promise<number> {
  let config: Config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
  } catch (e) {
    console.log("No config found, creating one for the first time...");
    config = await initConfig();
  }
  const command = process.argv[2];
  switch (command) {
    case "out": {
      const session = await checkOut(config);
      if (session !== null) {
        console.log("Checked out:", JSON.stringify(session, null, 4));
      }
      return 0;
    }
    case "in": {
      await checkIn(config);
      console.log("Checked in! Check out with `npx @eeue56/amser out`");
      return 0;
    }
    case "config": {
      await initConfig();
      return 0;
    }
    case "display": {
      const maybeThirdArgument = process.argv[3];
      const timeRange: TimeRange = isTimeRange(maybeThirdArgument)
        ? maybeThirdArgument
        : "week";
      await display(config, timeRange);
      return 0;
    }
    case undefined:
    case "help": {
      helpMessage();
      return -1;
    }
    default: {
      console.log(`No such command as "${command}".`);
      helpMessage();
      return -1;
    }
  }
}

main();
