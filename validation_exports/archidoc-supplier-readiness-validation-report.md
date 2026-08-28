# ArchiDoc supplier readiness development validation

- Overall: PASS
- Bootstrap: HTTP 200; contract version supplier-payment-readiness.v1; 1 change(s); fixture supplier present: yes
- Incremental repeatability: HTTP 200 and HTTP 200; response bodies identical: yes; change counts: 0 and 0
- Protected RIB: HTTP 200; Content-Type application/pdf: yes; Content-Disposition attachment: yes; Cache-Control private, no-store: yes; ETag contains declared SHA-256: yes; downloaded bytes match declared SHA-256: yes
- Incorrect RIB hash: HTTP 409; code RIB_VERSION_MISMATCH
