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
    private static double threshold;
    private static double dpi;

    public static void main(String[] args) throws Exception {
        key = env("MATCHING_KEY", "");
        if (key.isBlank()) {
            System.err.println("MATCHING_KEY is not set. Set it before starting the service, e.g.");
            System.err.println("  set MATCHING_KEY=change-me && java -jar target/matching-service.jar");
            System.exit(1);
        }
        threshold = numberEnv("MATCHING_THRESHOLD", 40);
        dpi = numberEnv("MATCHING_DPI", 500);

        HttpServer server = HttpServer.create(
                new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 0);
        server.createContext("/health", new HealthHandler());
        server.createContext("/template", new TemplateHandler());
        server.createContext("/identify", new IdentifyHandler());
        server.createContext("/", new NotFoundHandler());
        server.setExecutor(Executors.newFixedThreadPool(Math.max(2, Runtime.getRuntime().availableProcessors())));
        server.start();

        System.out.println("matching service listening on http://127.0.0.1:" + PORT);
        System.out.println("DPI=" + trim(dpi) + " threshold=" + trim(threshold) + " (MATCHING_KEY is set)");
        System.out.println("POST /template, POST /identify, GET /health");
    }

    /* ── Endpoints ─────────────────────────────────────────────────────── */

    private static final class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) {
                send(exchange, 405, error("method not allowed; use GET"));
                return;
            }
            send(exchange, 200, "{\"status\":\"ok\"}");
        }
    }

    private static final class NotFoundHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            send(exchange, 404, error("not found; use POST /template or POST /identify"));
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

                FingerprintMatcher matcher = new FingerprintMatcher(toTemplate(image));
                Integer bestId = null;
                double bestScore = Double.NEGATIVE_INFINITY;
                int comparisons = 0;

                for (Candidate candidate : candidates) {
                    for (FingerprintTemplate template : candidate.templates) {
                        double score = matcher.match(template);
                        comparisons++;
                        if (score > bestScore) {
                            bestScore = score;
                            bestId = candidate.id;
                        }
                    }
                }

                if (bestId == null) {
                    throw new BadRequest("candidates must contain at least one template");
                }

                String json;
                if (bestScore >= threshold) {
                    json = "{\"match\":{\"id\":" + bestId + ",\"score\":" + round(bestScore) + "}}";
                } else {
                    json = "{\"match\":null,\"bestScore\":" + round(bestScore) + "}";
                }
                log("identify", 200, started,
                        "candidates=" + candidates.size() + " templates=" + comparisons
                                + " best=" + round(bestScore)
                                + " match=" + (bestScore >= threshold ? bestId : "none"));
                send(exchange, 200, json);
            } catch (PayloadException e) {
                log("identify", e.status, started, "");
                send(exchange, e.status, error(e.getMessage()));
            } catch (Exception e) {
                log("identify", 400, started, "");
                send(exchange, 400, error(describe(e)));
            }
        }
    }

    private record Candidate(int id, List<FingerprintTemplate> templates) {}

    private static List<Candidate> readCandidates(Object raw) {
        if (!(raw instanceof List<?> list)) {
            throw new BadRequest("candidates must be an array of {\"id\": number, \"templates\": [base64, ...]}");
        }
        if (list.isEmpty()) {
            throw new BadRequest("candidates must not be empty");
        }
        List<Candidate> candidates = new ArrayList<>(list.size());
        int index = 0;
        for (Object entry : list) {
            if (!(entry instanceof Map<?, ?> object)) {
                throw new BadRequest("candidates[" + index + "] must be a JSON object");
            }
            Object idValue = object.get("id");
            int id;
            if (idValue instanceof Double number && number == Math.rint(number)) {
                id = number.intValue();
            } else if (idValue instanceof String text && text.matches("-?\\d+")) {
                id = Integer.parseInt(text);
            } else {
                throw new BadRequest("candidates[" + index + "].id must be an integer");
            }

            Object templateValue = object.get("templates");
            if (!(templateValue instanceof List<?> templateList) || templateList.isEmpty()) {
                throw new BadRequest("candidates[" + index + "].templates must be a non-empty array of base64 templates");
            }

            List<FingerprintTemplate> templates = new ArrayList<>(templateList.size());
            int position = 0;
            for (Object encoded : templateList) {
                if (!(encoded instanceof String text) || text.isBlank()) {
                    throw new BadRequest("candidates[" + index + "].templates[" + position + "] must be a base64 string");
                }
                byte[] bytes = decodeBase64(text);
                try {
                    templates.add(new FingerprintTemplate(bytes));
                } catch (RuntimeException e) {
                    throw new BadRequest("candidates[" + index + "].templates[" + position
                            + "] is not a SourceAFIS template; enroll the image with POST /template first");
                }
                position++;
            }
            candidates.add(new Candidate(id, templates));
            index++;
        }
        return candidates;
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
