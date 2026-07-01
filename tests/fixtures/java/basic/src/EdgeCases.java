package basic;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

public class EdgeCases {
    // Static initializer block (not a method)
    static {
        System.out.println("static init");
    }

    // Varargs parameter
    public String joinStrings(String separator, String... items) {
        return String.join(separator, items);
    }

    // Generic method
    public <T> List<T> wrapInList(T item) {
        return Arrays.asList(item);
    }

    // Generic return type
    public Map<String, Object> getMetadata() {
        return Map.of("key", "value");
    }

    // Annotation (custom)
    @Deprecated
    public void oldMethod() {}

    // Method with throws clause
    public void riskyMethod() throws Exception {
        throw new Exception("error");
    }

    // Inner class with methods
    public static class InnerHelper {
        public String help() {
            return "helping";
        }
    }

    // Anonymous class / lambda patterns
    public Runnable createTask() {
        return () -> System.out.println("task");
    }

    // Forward reference test: publicApi calls privateHelper defined LATER.
    // With two-pass extraction, this should resolve correctly (M1 fix).
    public String publicApi(String input) {
        return privateHelper(input);
    }

    private String privateHelper(String s) {
        return s.toUpperCase();
    }

    // this.method() call (M3 fix)
    public void callerUsingThis() {
        this.oldMethod();
    }
}

// Enum with methods (M4 fix)
enum Color {
    RED, GREEN, BLUE;

    public String display() {
        return this.name().toLowerCase();
    }

    public boolean isPrimary() {
        return this == RED || this == GREEN || this == BLUE;
    }
}
