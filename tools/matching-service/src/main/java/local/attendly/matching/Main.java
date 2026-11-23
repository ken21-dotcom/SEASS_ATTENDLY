package local.attendly.matching;

import com.machinezoo.sourceafis.FingerprintImage;
import com.machinezoo.sourceafis.FingerprintImageOptions;
import com.machinezoo.sourceafis.FingerprintMatcher;
import com.machinezoo.sourceafis.FingerprintTemplate;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Standalone fingerprint matching service for ATTENDLY.
 *
 * Listens on 127.0.0.1:8090 only. Every API call must carry X-Matching-Key with
 * the value of MATCHING_KEY. Images and templates are handled in memory and are
 * never written to disk or logged; logs contain request type, durations, counts
 * and scores only.
 */
public final class Main {
    private static final int PORT = 8090;
    private static final int MAX_BODY_BYTES = 8 * 1024 * 1024;

    private static String key;
    private static double threshold;          // 1:N identification (enrollment duplicate check)
    private static double verifyThreshold;    // 1:1 kiosk verification
    private static double dpi;

    public static void main(String[] args) throws Exception {
        key = env("MATCHING_KEY", "");
        if (key.isBlank()) {
            System.err.println("MATCHING_KEY is not set. Set it before starting the service, e.g.");
            System.err.println("  set MATCHING_KEY=change-me && java -jar target/matching-service.jar");
            System.exit(1);
        }
        threshold = numberEnv("MATCHING_THRESHOLD", 40);
        verifyThreshold = numberEnv("MATCHING_VERIFY_THRESHOLD", 30);
        dpi = numberEnv("MATCHING_DPI", 512);

        HttpServer server = HttpServer.create(
                new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 0);
        server.createContext("/health", new HealthHandler());
        server.createContext("/template", new TemplateHandler());
        server.createContext("/verify", new VerifyHandler());
        server.createContext("/identify", new IdentifyHandler());
        server.createContext("/", new NotFoundHandler());
        server.setExecutor(Executors.newFixedThreadPool(Math.max(2, Runtime.getRuntime().availableProcessors())));
        server.start();

        System.out.println("matching service listening on http://127.0.0.1:" + PORT);
        System.out.println("DPI=" + trim(dpi) + " threshold=" + trim(threshold)
                + " verifyThreshold=" + trim(verifyThreshold) + " (MATCHING_KEY is set)");
        System.out.println("POST /template, POST /verify, POST /identify, GET /health");
    }

    /* ── Endpoints ─────────────────────────────────────────────────────── */

    private static final class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) {
                send(exchange, 405, error("method not allowed; use GET"));
                return;
            }
            send(exchange, 200, "{\"status\":\"ok\",\"dpi\":" + trim(dpi)
                    + ",\"threshold\":" + trim(threshold)
                    + ",\"verifyThreshold\":" + trim(verifyThreshold) + "}");
        }
    }

    private static final class NotFoundHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            send(exchange, 404, error("not found; use POST /template, POST /verify or POST /identify"));
        }
    }

    /** POST /template {"image": base64 PNG} -> {"template": base64} */
    private static final class TemplateHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            long started = System.nanoTime();
            try {
                if (!"POST".equals(exchange.getRequestMethod())) {
                    log("template", 405, started, "");
                    send(exchange, 405, error("method not allowed; use POST"));
                    return;
                }
                if (!keyMatches(exchange)) {
                    log("template", 401, started, "");
                    send(exchange, 401, error("missing or invalid X-Matching-Key"));
                    return;
                }
                String body = readBody(exchange);
                Map<String, Object> request = Json.parseObject(body, "body");
                byte[] image = decodeImage(request.get("image"));
                byte[] template = toTemplate(image).toByteArray();
                log("template", 200, started, "template=" + template.length + "B");
                send(exchange, 200, "{\"template\":" + Json.quote(Base64.getEncoder().encodeToString(template)) + "}");
            } catch (PayloadException e) {
                log("template", e.status, started, "");
                send(exchange, e.status, error(e.getMessage()));
            } catch (Exception e) {
                log("template", 400, started, "");
                send(exchange, 400, error(describe(e)));
            }
        }
    }

    /** POST /identify {"image", "candidates":[{"id","templates":[...]}]} -> best match */
    private static final class IdentifyHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            long started = System.nanoTime();
            try {
                if (!"POST".equals(exchange.getRequestMethod())) {
                    log("identify", 405, started, "");
                    send(exchange, 405, error("method not allowed; use POST"));
                    return;
                }
                if (!keyMatches(exchange)) {
                    log("identify", 401, started, "");
                    send(exchange, 401, error("missing or invalid X-Matching-Key"));
                    return;
                }
                Map<String, Object> request = Json.parseObject(readBody(exchange), "body");
                byte[] image = decodeImage(request.get("image"));
                List<Candidate> candidates = readCandidates(request.get("candidates"));
                BestMatch best = bestMatch(image, candidates);

                log("identify", 200, started,
                        "candidates=" + candidates.size() + " templates=" + best.comparisons
                                + " best=" + round(best.score)
                                + " match=" + (best.score >= threshold ? best.id : "none")
                                + " finger=" + (best.score >= threshold && best.finger != null ? best.finger : "none"));
                send(exchange, 200, matchJson(best, threshold));
            } catch (PayloadException e) {
                log("identify", e.status, started, "");
                send(exchange, e.status, error(e.getMessage()));
            } catch (Exception e) {
                log("identify", 400, started, "");
                send(exchange, 400, error(describe(e)));
            }
        }
    }

    /**
     * POST /verify — compare one probe against one student's templates.
     *
     * The typed student ID has already scoped the candidate in PHP, so this is
     * the fast 1:1 kiosk path rather than the 1:N /identify fan-out. PHP sends
     * its configured threshold in the body; MATCHING_VERIFY_THRESHOLD is the
     * default when the field is absent.
     */
    private static final class VerifyHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            long started = System.nanoTime();
            try {
                if (!"POST".equals(exchange.getRequestMethod())) {
                    log("verify", 405, started, "");
                    send(exchange, 405, error("method not allowed; use POST"));
                    return;
                }
                if (!keyMatches(exchange)) {
                    log("verify", 401, started, "");
                    send(exchange, 401, error("missing or invalid X-Matching-Key"));
                    return;
                }
                Map<String, Object> request = Json.parseObject(readBody(exchange), "body");
                byte[] image = decodeImage(request.get("image"));
                Candidate candidate = readCandidate(request.get("candidate"), 0);
                double effectiveThreshold = requestThreshold(request.get("threshold"), verifyThreshold);
                BestMatch best = bestMatch(image, List.of(candidate));

                log("verify", 200, started,
                        "templates=" + best.comparisons
                                + " best=" + round(best.score)
                                + " threshold=" + trim(effectiveThreshold)
                                + " match=" + (best.score >= effectiveThreshold ? best.id : "none")
                                + " finger=" + (best.score >= effectiveThreshold && best.finger != null ? best.finger : "none"));
                send(exchange, 200, matchJson(best, effectiveThreshold));
            } catch (PayloadException e) {
                log("verify", e.status, started, "");
                send(exchange, e.status, error(e.getMessage()));
            } catch (Exception e) {
                log("verify", 400, started, "");
                send(exchange, 400, error(describe(e)));
            }
        }
    }

    private record Candidate(int id, List<FingerprintTemplate> templates, List<String> fingers) {}

    private record BestMatch(Integer id, String finger, double score, int comparisons) {}

    /** Compare a probe image against the supplied templates and keep the best score. */
    private static BestMatch bestMatch(byte[] image, List<Candidate> candidates) {
        FingerprintMatcher matcher = new FingerprintMatcher(toTemplate(image));
        Integer bestId = null;
        String bestFinger = null;
        double bestScore = Double.NEGATIVE_INFINITY;
        int comparisons = 0;

        for (Candidate candidate : candidates) {
            for (int index = 0; index < candidate.templates.size(); index++) {
                double score = matcher.match(candidate.templates.get(index));
                comparisons++;
                if (score > bestScore) {
                    bestScore = score;
                    bestId = candidate.id;
                    bestFinger = candidate.fingers == null ? null : candidate.fingers.get(index);
                }
            }
        }
        if (bestId == null) {
            throw new BadRequest("candidate must contain at least one template");
        }
        return new BestMatch(bestId, bestFinger, bestScore, comparisons);
    }

    /** Shared response shape for /identify and /verify, including debug values. */
    private static String matchJson(BestMatch best, double threshold) {
        String fingerJson = best.finger == null ? "null" : Json.quote(best.finger);
        String matchJson = best.score >= threshold
                ? "{\"id\":" + best.id + ",\"score\":" + round(best.score)
                        + ",\"finger\":" + fingerJson + "}"
                : "null";
        return "{\"match\":" + matchJson
                + ",\"bestScore\":" + round(best.score)
                + ",\"threshold\":" + trim(threshold) + "}";
    }

    /** PHP owns the kiosk threshold; the environment value is only the default. */
    private static double requestThreshold(Object raw, double fallback) {
        if (raw == null) return fallback;
        double value;
        if (raw instanceof Double number) {
            value = number;
        } else if (raw instanceof String text && !text.isBlank()) {
            try {
                value = Double.parseDouble(text.trim());
            } catch (NumberFormatException e) {
                return fallback;
            }
        } else {
            return fallback;
        }
        if (!Double.isFinite(value) || value <= 0) return fallback;
        return Math.max(1, Math.min(100, value));
    }

    private static List<Candidate> readCandidates(Object raw) {
        if (!(raw instanceof List<?> list)) {
            throw new BadRequest("candidates must be an array of {\"id\": number, \"templates\": [base64, ...]}");
        }
        if (list.isEmpty()) {
            throw new BadRequest("candidates must not be empty");
        }
        List<Candidate> candidates = new ArrayList<>(list.size());
        for (int index = 0; index < list.size(); index++) {
            candidates.add(readCandidate(list.get(index), index));
        }
        return candidates;
    }

    private static Candidate readCandidate(Object raw, int index) {
        String name = index == 0 ? "candidate" : "candidates[" + index + "]";
        if (!(raw instanceof Map<?, ?> object)) {
            throw new BadRequest(name + " must be a JSON object");
        }
        Object idValue = object.get("id");
        int id;
        if (idValue instanceof Double number && number == Math.rint(number)) {
            id = number.intValue();
        } else if (idValue instanceof String text && text.matches("-?\\d+")) {
            id = Integer.parseInt(text);
        } else {
            throw new BadRequest(name + ".id must be an integer");
        }

        Object templateValue = object.get("templates");
        if (!(templateValue instanceof List<?> templateList) || templateList.isEmpty()) {
            throw new BadRequest(name + ".templates must be a non-empty array of base64 templates");
        }

        List<FingerprintTemplate> templates = new ArrayList<>(templateList.size());
        int position = 0;
        for (Object encoded : templateList) {
            if (!(encoded instanceof String text) || text.isBlank()) {
                throw new BadRequest(name + ".templates[" + position + "] must be a base64 string");
            }
            byte[] bytes = decodeBase64(text);
            try {
                templates.add(new FingerprintTemplate(bytes));
            } catch (RuntimeException e) {
                throw new BadRequest(name + ".templates[" + position
                        + "] is not a SourceAFIS template; enroll the image with POST /template first");
            }
            position++;
        }

        Object fingersValue = object.get("fingers");
        List<String> fingers = null;
        if (fingersValue != null) {
            if (!(fingersValue instanceof List<?> fingerList)) {
                throw new BadRequest(name + ".fingers must be an array of finger names");
            }
            if (fingerList.size() != templateList.size()) {
                throw new BadRequest(name + ".fingers must have one entry per template");
            }
            fingers = new ArrayList<>(fingerList.size());
            int fingerIndex = 0;
            for (Object encoded : fingerList) {
                if (encoded == null) {
                    fingers.add(null);
                } else if (encoded instanceof String text && !text.isBlank()) {
                    fingers.add(text.trim());
                } else {
                    throw new BadRequest(name + ".fingers[" + fingerIndex + "] must be a finger name or null");
                }
                fingerIndex++;
            }
        }
        return new Candidate(id, templates, fingers);
    }

    /* ── Fingerprint plumbing ──────────────────────────────────────────── */

    private static FingerprintTemplate toTemplate(byte[] png) {
        try {
            return new FingerprintTemplate(new FingerprintImage(png, new FingerprintImageOptions().dpi(dpi)));
        } catch (RuntimeException e) {
            throw new BadRequest("could not read a fingerprint from the image"
                    + " (not a supported PNG, or the capture has too few readable ridges);"
                    + " send a PNG from SampleFormat.PngImage.");
        }
    }

    private static byte[] decodeImage(Object raw) {
        if (!(raw instanceof String text) || text.isBlank()) {
            throw new BadRequest("image must be a base64 or base64url PNG string");
        }
        byte[] bytes = decodeBase64(text);
        if (bytes.length == 0) throw new BadRequest("image decoded to zero bytes");
        return bytes;
    }

    private static byte[] decodeBase64(String text) {
        String value = text.trim();
        int comma = value.indexOf(',');
        if (value.startsWith("data:") && comma > 0) value = value.substring(comma + 1);
        value = value.replaceAll("\\s+", "").replace('-', '+').replace('_', '/');
        int padding = (4 - value.length() % 4) % 4;
        value = value + "=".repeat(padding);
        try {
            return Base64.getDecoder().decode(value);
        } catch (IllegalArgumentException e) {
            throw new BadRequest("value is not valid base64");
        }
    }

    /* ── HTTP helpers ──────────────────────────────────────────────────── */

    private static String readBody(HttpExchange exchange) throws IOException {
        Headers headers = exchange.getRequestHeaders();
        String type = headers.getFirst("Content-Type");
        if (type != null && !type.toLowerCase().contains("application/json")) {
            throw new PayloadException(415, "Content-Type must be application/json");
        }
        try (InputStream in = exchange.getRequestBody();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BODY_BYTES) {
                    throw new PayloadException(413, "request body is larger than " + MAX_BODY_BYTES + " bytes");
                }
                out.write(buffer, 0, read);
            }
            String body = out.toString(StandardCharsets.UTF_8);
            if (body.isBlank()) throw new BadRequest("request body must be JSON");
            return body;
        }
    }

    private static boolean keyMatches(HttpExchange exchange) {
        String provided = exchange.getRequestHeaders().getFirst("X-Matching-Key");
        if (provided == null) return false;
        return MessageDigest.isEqual(
                provided.getBytes(StandardCharsets.UTF_8),
                key.getBytes(StandardCharsets.UTF_8));
    }

    private static void send(HttpExchange exchange, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    private static String error(String message) {
        return "{\"error\":" + Json.quote(message == null ? "request failed" : message) + "}";
    }

    /** Type, duration and score/size counts only — never image or template bytes. */
    private static void log(String endpoint, int status, long startedNanos, String detail) {
        long millis = (System.nanoTime() - startedNanos) / 1_000_000;
        String line = "[" + endpoint + "] " + status + " " + millis + "ms";
        if (!detail.isEmpty()) line += " " + detail;
        System.out.println(line);
    }

    /* ── Small helpers ─────────────────────────────────────────────────── */

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static double numberEnv(String name, double fallback) {
        String value = env(name, "");
        if (value.isEmpty()) return fallback;
        try {
            double parsed = Double.parseDouble(value);
            return parsed > 0 ? parsed : fallback;
        } catch (NumberFormatException e) {
            System.out.println("ignoring " + name + "=" + value + ", using " + fallback);
            return fallback;
        }
    }

    private static double round(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    private static String trim(double value) {
        return value == Math.rint(value) ? String.valueOf((long) value) : String.valueOf(value);
    }

    private static String describe(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private static final class BadRequest extends RuntimeException {
        BadRequest(String message) {
            super(message);
        }
    }

    private static final class PayloadException extends RuntimeException {
        final int status;

        PayloadException(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
