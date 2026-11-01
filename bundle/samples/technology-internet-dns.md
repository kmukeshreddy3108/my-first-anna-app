# How the internet and DNS work

The internet is a network of networks that moves data using shared protocols.
A device typically connects through Wi-Fi or Ethernet to a local router. The
router forwards packets to an internet service provider, and routers operated
by many networks pass those packets toward a destination. Internet Protocol
addresses identify endpoints, while the Transmission Control Protocol can
reassemble packets and retransmit lost data. The newer HTTP/3 protocol can use
QUIC over UDP to reduce connection setup delay.

Domain Name System (DNS) translates names such as example.com into address
records. People remember names more easily than numeric addresses, and DNS
provides a distributed naming system. A resolver may answer from its cache.
If it has no answer, it asks a root server which authoritative top-level
domain server handles the suffix, such as .com. It then asks the authoritative
server for the domain's record. Time to live values tell caches how long a
response may be reused.

The basic web request process is:

1. The browser checks local and resolver caches for a DNS answer.
2. The browser opens a connection to the returned address.
3. For HTTPS, the browser performs a TLS handshake and verifies a certificate.
4. It sends an HTTP request containing a method, path, headers, and possibly a
   body.
5. The server returns a status code, headers, and content.
6. The browser renders the response and may request images, scripts, or styles.

Security depends on several layers. TLS protects confidentiality and helps
authenticate a server, but it does not make every website trustworthy.
DNSSEC can sign DNS data, while encrypted DNS protects the query from some
observers. Firewalls, authentication, software updates, and careful handling
of links remain important. Caches improve speed but mean that changes may not
appear until old records expire.
