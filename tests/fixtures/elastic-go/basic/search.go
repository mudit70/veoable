package main

import (
	"strings"

	"github.com/elastic/go-elasticsearch/v8"
)

func newClient() (*elasticsearch.Client, error) {
	return elasticsearch.NewDefaultClient()
}

func indexUser(es *elasticsearch.Client, doc string) error {
	_, err := es.Index("users", strings.NewReader(doc))
	return err
}

func getUser(es *elasticsearch.Client, id string) error {
	_, err := es.Get("users", id)
	return err
}

func updateUser(es *elasticsearch.Client, id string, doc string) error {
	_, err := es.Update("users", id, strings.NewReader(doc))
	return err
}

func deleteUser(es *elasticsearch.Client, id string) error {
	_, err := es.Delete("users", id)
	return err
}

func searchOrders(es *elasticsearch.Client, body string) error {
	_, err := es.Search(
		es.Search.WithIndex("orders"),
		es.Search.WithBody(strings.NewReader(body)),
	)
	return err
}

func existsAudit(es *elasticsearch.Client, id string) error {
	_, err := es.Exists("audit-log", id)
	return err
}

func dynamicIndex(es *elasticsearch.Client, index string) error {
	// Dynamic index — must NOT emit.
	_, err := es.Get(index, "1")
	return err
}
