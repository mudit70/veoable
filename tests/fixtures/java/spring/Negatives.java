package com.example;

// No Spring annotations — should NOT produce endpoints
public class Negatives {
    public void get() {}
    public void post() {}

    // Custom annotation — not Spring
    @Deprecated
    public void oldMethod() {}
}
