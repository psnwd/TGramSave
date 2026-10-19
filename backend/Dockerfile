FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tgsd ./cmd/tgsd
RUN mkdir /data

FROM gcr.io/distroless/static:nonroot
COPY --from=build /tgsd /tgsd
COPY --from=build --chown=nonroot:nonroot /data /data
ENV DB_PATH=/data/tgsd.db
VOLUME /data
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/tgsd", "serve"]
