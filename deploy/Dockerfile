# One image definition for every service. Build with:
#   docker build -f deploy/Dockerfile --build-arg PROJECT=Factory.Api .
ARG PROJECT

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG PROJECT
WORKDIR /src
COPY . .
RUN dotnet publish "src/${PROJECT}/${PROJECT}.csproj" -c Release -o /app --nologo

FROM mcr.microsoft.com/dotnet/aspnet:10.0
ARG PROJECT
ENV FACTORY_SERVICE=${PROJECT}
WORKDIR /app
COPY --from=build /app .
COPY db ./db
USER $APP_UID
ENTRYPOINT ["sh", "-c", "exec dotnet \"$FACTORY_SERVICE.dll\""]
