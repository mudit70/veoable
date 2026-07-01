package main

// File without websocket imports — must produce zero emits.

type fakeUpgrader struct{}

func (u *fakeUpgrader) Upgrade(_, _, _ interface{}) (interface{}, error) {
	return nil, nil
}

func local() {
	u := &fakeUpgrader{}
	u.Upgrade(nil, nil, nil)
}
