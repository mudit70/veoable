// Fixture for framework-goredis.
package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "localhost:6379"})

func GetUser(ctx context.Context, id int) {
	rdb.Get(ctx, fmt.Sprintf("user:%d", id))
}

func SetUser(ctx context.Context, id int, value string) {
	rdb.Set(ctx, fmt.Sprintf("user:%d", id), value, 0)
}

func IncrementCounter(ctx context.Context) {
	rdb.Incr(ctx, "counter:requests")
}

func DecrementCounter(ctx context.Context) {
	rdb.Decr(ctx, "counter:requests")
}

func HSetUserProfile(ctx context.Context, id int, field, val string) {
	rdb.HSet(ctx, fmt.Sprintf("user:%d:profile", id), field, val)
}

func HGetUserProfile(ctx context.Context, id int) {
	rdb.HGetAll(ctx, fmt.Sprintf("user:%d:profile", id))
}

func AddToSet(ctx context.Context, member string) {
	rdb.SAdd(ctx, "active_users", member)
}

func RemoveFromSet(ctx context.Context, member string) {
	rdb.SRem(ctx, "active_users", member)
}

func AddToSortedSet(ctx context.Context, score float64, member string) {
	rdb.ZAdd(ctx, "leaderboard", &redis.Z{Score: score, Member: member})
}

func QueryLeaderboard(ctx context.Context) {
	rdb.ZRange(ctx, "leaderboard", 0, 10)
}

func LPushQueue(ctx context.Context, item string) {
	rdb.LPush(ctx, "queue:jobs", item)
}

func RPushQueue(ctx context.Context, item string) {
	rdb.RPush(ctx, "queue:jobs", item)
}

func LPopQueue(ctx context.Context) {
	rdb.LPop(ctx, "queue:jobs")
}

func ExpireSession(ctx context.Context, id int) {
	rdb.Expire(ctx, fmt.Sprintf("session:%d", id), 0)
}

func DeleteUser(ctx context.Context, id int) {
	rdb.Del(ctx, fmt.Sprintf("user:%d", id))
}

func PublishEvent(ctx context.Context, channel, message string) {
	rdb.Publish(ctx, channel, message)
}

// ── Dynamic key — non-string arg ──
func DynamicKey(ctx context.Context, key string) {
	rdb.Get(ctx, key)
}

// ── selector binding `s.rdb` inside a struct method ──
type CacheService struct {
	rdb *redis.Client
}

func NewCacheService() *CacheService {
	return &CacheService{rdb: redis.NewClient(&redis.Options{})}
}

func (s *CacheService) Fetch(ctx context.Context, key string) {
	s.rdb.Get(ctx, key)
}

// ── Negative: a method on something that isn't a Redis client ──
type kvStore struct{}

func (k *kvStore) Get(ctx context.Context, key string) string { return key }

func unrelated(ctx context.Context) {
	k := &kvStore{}
	k.Get(ctx, "not_a_redis_key")
}
