#!/usr/bin/env bun
/** The CLI entry: run argv, and leave the exit code to Loom. */
import { createApp } from './app';

await createApp().run();
