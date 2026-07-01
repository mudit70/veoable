package basic;

import java.util.List;
import java.util.Map;

public class Main {
    // Public method — exported
    public String greet(String name) {
        return formatGreeting(name);
    }

    // Private method — not exported
    private String formatGreeting(String name) {
        return "Hello, " + name;
    }

    // Static method
    public static int add(int a, int b) {
        return a + b;
    }

    // Method with multiple params and return type
    public Map<String, Object> processData(String key, int value, boolean flag) {
        return Map.of(key, value);
    }

    // Void method
    public void doNothing() {}

    // Method calling other methods (call graph)
    public void caller() {
        greet("Alice");
        String msg = formatGreeting("Bob");
        int sum = add(1, 2);
        doNothing();
    }

    // Main entry point
    public static void main(String[] args) {
        Main m = new Main();
        m.caller();
    }
}
