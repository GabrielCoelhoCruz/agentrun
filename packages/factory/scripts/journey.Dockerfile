FROM python:3.12-bookworm@sha256:5560e9ab8709f459489e5b8aa696eda8a07ef821e14bb122be62d91234bfa98b AS python
FROM node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0
COPY --from=python /usr/local/ /usr/local/
COPY packages/factory/test/fixtures/container-probe.mjs packages/factory/test/fixtures/server-durable.ts packages/factory/test/fixtures/server-durable.py /opt/proof/
COPY packages/factory/scripts/journey-evidence.py /opt/harness/journey-evidence.py
RUN mkdir /opt/tools && printf '#!/bin/sh\nexec /usr/local/bin/python3 -I /opt/harness/journey-evidence.py git /usr/bin/git "$@"\n' > /opt/tools/git && chmod 755 /opt/tools/git
USER 1000:1000
WORKDIR /work
CMD ["/bin/sleep", "infinity"]
