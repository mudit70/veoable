import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCollectionHelperMap } from '../helpers-resolver.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mongogo-helpers-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(rel: string, contents: string): void {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

describe('buildCollectionHelperMap — return-type shapes (#527)', () => {
  it('parses the bare `*mongo.Collection` return', () => {
    writeFile('db/mongo.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Vehicles(c *mongo.Client) *mongo.Collection {
    return c.Database("fleet").Collection("vehicles")
}
`);
    const m = buildCollectionHelperMap(tmp);
    expect(m.byFunctionName.get('Vehicles')).toBe('vehicles');
  });

  it('parses a tuple return `(*mongo.Collection, error)`', () => {
    writeFile('db/mongo.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Users(c *mongo.Client) (*mongo.Collection, error) {
    return c.Database("app").Collection("users"), nil
}
`);
    const m = buildCollectionHelperMap(tmp);
    expect(m.byFunctionName.get('Users')).toBe('users');
  });

  it('parses a named return `(col *mongo.Collection)`', () => {
    writeFile('db/mongo.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Comments(c *mongo.Client) (col *mongo.Collection) {
    col = c.Database("app").Collection("comments")
    return
}
`);
    const m = buildCollectionHelperMap(tmp);
    expect(m.byFunctionName.get('Comments')).toBe('comments');
  });

  it('parses a named tuple return `(col *mongo.Collection, err error)`', () => {
    writeFile('db/mongo.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Posts(c *mongo.Client) (col *mongo.Collection, err error) {
    col = c.Database("app").Collection("posts")
    return col, nil
}
`);
    const m = buildCollectionHelperMap(tmp);
    expect(m.byFunctionName.get('Posts')).toBe('posts');
  });

  it('parses a generic helper `func X[T any]() *mongo.Collection`', () => {
    writeFile('db/mongo.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Articles[T any](c *mongo.Client) *mongo.Collection {
    return c.Database("app").Collection("articles")
}
`);
    const m = buildCollectionHelperMap(tmp);
    expect(m.byFunctionName.get('Articles')).toBe('articles');
  });

  it('parses generic + tuple-return combined', () => {
    writeFile('db/mongo.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Tags[T comparable](c *mongo.Client) (*mongo.Collection, error) {
    return c.Database("app").Collection("tags"), nil
}
`);
    const m = buildCollectionHelperMap(tmp);
    expect(m.byFunctionName.get('Tags')).toBe('tags');
  });

  it('parses a method receiver alongside the new return shapes', () => {
    writeFile('db/store.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

type Store struct{ client *mongo.Client }

func (s *Store) Sessions() (col *mongo.Collection) {
    col = s.client.Database("app").Collection("sessions")
    return
}
`);
    const m = buildCollectionHelperMap(tmp);
    expect(m.byFunctionName.get('Sessions')).toBe('sessions');
  });
});

describe('buildCollectionHelperMap — collision diagnostic (#527)', () => {
  it('warns once when the same helper name maps to different collections', () => {
    writeFile('serviceA/db.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Vehicles(c *mongo.Client) *mongo.Collection {
    return c.Database("fleetA").Collection("vehiclesA")
}
`);
    writeFile('serviceB/db.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Vehicles(c *mongo.Client) *mongo.Collection {
    return c.Database("fleetB").Collection("vehiclesB")
}
`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = buildCollectionHelperMap(tmp);
    // Last-write-wins is preserved — one of the two ends up in the map.
    const winner = m.byFunctionName.get('Vehicles');
    expect(winner === 'vehiclesA' || winner === 'vehiclesB').toBe(true);
    // And a warning was logged.
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(msg).toContain('framework-mongogo');
    expect(msg).toContain('Vehicles');
    expect(msg).toContain('last-write-wins');
    warn.mockRestore();
  });

  it('does NOT warn when the same name maps to the same collection', () => {
    // Two files defining the same helper for the same collection is
    // a no-op overwrite; no warning should fire.
    writeFile('a.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Vehicles(c *mongo.Client) *mongo.Collection {
    return c.Database("fleet").Collection("vehicles")
}
`);
    writeFile('b.go', `package db

import "go.mongodb.org/mongo-driver/mongo"

func Vehicles(c *mongo.Client) *mongo.Collection {
    return c.Database("fleet").Collection("vehicles")
}
`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildCollectionHelperMap(tmp);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
